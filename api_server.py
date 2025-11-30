#!/usr/bin/env python3
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import httpx
import asyncio
import aiofiles
import re
import time
import os
import uuid
import hashlib
from typing import Optional, Dict, Any, Set
from collections import defaultdict
import uvicorn
import sys
import random
from contextlib import asynccontextmanager
from bs4 import BeautifulSoup
from datetime import datetime
from curl_cffi import requests as curl_requests
from curl_cffi.requests import AsyncSession

DOWNLOADS_DIR = os.path.join(os.path.dirname(__file__), 'app_cache')
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

url_cache: Dict[str, tuple] = {}
URL_CACHE_TTL = 1800

file_cache: Dict[str, Dict[str, Any]] = {}

download_locks: Dict[str, asyncio.Lock] = {}
user_downloads: Dict[str, Set[str]] = defaultdict(set)

pending_deletions: Dict[str, asyncio.Task] = {}

http_client: Optional[httpx.AsyncClient] = None

stats = {
    "total_requests": 0,
    "cache_hits": 0,
    "downloads": 0,
    "active_downloads": 0,
    "cached_files": 0
}

def get_client() -> httpx.AsyncClient:
    if http_client is None:
        raise RuntimeError("HTTP client not initialized")
    return http_client

def get_download_lock(package_name: str) -> asyncio.Lock:
    if package_name not in download_locks:
        download_locks[package_name] = asyncio.Lock()
    return download_locks[package_name]

def generate_user_file_id(package_name: str, user_id: Optional[str] = None) -> str:
    unique_id = user_id or str(uuid.uuid4())[:8]
    return f"{package_name}_{unique_id}_{int(time.time())}"

async def schedule_file_deletion(file_path: str, delay: int = 30):
    await asyncio.sleep(delay)
    try:
        if os.path.exists(file_path):
            os.remove(file_path)
            print(f"[Cleanup] Deleted: {os.path.basename(file_path)}", file=sys.stderr)
            
            for pkg, info in list(file_cache.items()):
                if info.get('file_path') == file_path:
                    del file_cache[pkg]
                    stats["cached_files"] = max(0, stats["cached_files"] - 1)
                    break
    except Exception as e:
        print(f"[Cleanup Error] {file_path}: {e}", file=sys.stderr)

def cleanup_old_files():
    try:
        now = time.time()
        max_age = 300
        
        for filename in os.listdir(DOWNLOADS_DIR):
            file_path = os.path.join(DOWNLOADS_DIR, filename)
            if os.path.isfile(file_path):
                file_age = now - os.path.getmtime(file_path)
                if file_age > max_age:
                    os.remove(file_path)
                    print(f"[Cleanup] Removed old file: {filename}", file=sys.stderr)
    except Exception as e:
        print(f"[Cleanup Error] {e}", file=sys.stderr)

async def periodic_cleanup():
    while True:
        await asyncio.sleep(60)
        cleanup_old_files()

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(120.0, connect=30.0),
        limits=httpx.Limits(max_connections=2000, max_keepalive_connections=1000),
        follow_redirects=True,
        headers={
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
    )
    
    asyncio.create_task(periodic_cleanup())
    
    print("[Server] Started with high-performance configuration", file=sys.stderr)
    yield
    
    for task in pending_deletions.values():
        task.cancel()
    
    if http_client:
        await http_client.aclose()

app = FastAPI(title="AppOmar APK Download API", version="4.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
]

download_semaphore = asyncio.Semaphore(200)

def get_headers() -> Dict[str, str]:
    return {
        'User-Agent': random.choice(USER_AGENTS),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
    }

@app.get("/")
async def root() -> Dict[str, Any]:
    return {
        "service": "AppOmar APK Download API",
        "version": "4.0.0",
        "status": "running",
        "source": "APKPure Only",
        "features": ["file_caching", "auto_cleanup", "concurrent_downloads"]
    }

@app.get("/health")
async def health_check() -> Dict[str, str]:
    return {"status": "healthy"}

@app.get("/stats")
async def get_stats() -> Dict[str, Any]:
    return {
        **stats,
        "cached_urls": len(url_cache),
        "cached_files": len([f for f in os.listdir(DOWNLOADS_DIR) if os.path.isfile(os.path.join(DOWNLOADS_DIR, f))]),
        "active_locks": len([l for l in download_locks.values() if l.locked()]),
        "pending_deletions": len(pending_deletions)
    }

async def get_apkpure_app_slug(package_name: str) -> Optional[str]:
    try:
        client = get_client()
        search_url = f"https://apkpure.com/search?q={package_name}"
        response = await client.get(search_url, headers=get_headers())
        
        if response.status_code != 200:
            return None
            
        soup = BeautifulSoup(response.text, 'html.parser')
        
        for link in soup.find_all('a', href=True):
            href_attr = link.get('href')
            href = str(href_attr) if href_attr else ''
            if f'/{package_name}' in href and '/download' not in href:
                parts = href.strip('/').split('/')
                if len(parts) >= 1:
                    return parts[0]
        
        return package_name
    except Exception as e:
        print(f"[Slug] {package_name}: {e}", file=sys.stderr)
        return package_name

async def resolve_apkpure_download_url(package_name: str, file_type: str = "XAPK") -> Optional[str]:
    try:
        client = get_client()
        slug = await get_apkpure_app_slug(package_name)
        if not slug:
            slug = package_name
        
        download_page_url = f"https://apkpure.com/{slug}/{package_name}/download"
        
        response = await client.get(download_page_url, headers=get_headers())
        
        if response.status_code != 200:
            return None
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        download_link = soup.find('a', {'id': 'download_link'})
        if download_link:
            href_attr = download_link.get('href')
            if href_attr:
                url = str(href_attr)
                if url.startswith('http'):
                    return url
        
        for a_tag in soup.find_all('a', href=True):
            href_attr = a_tag.get('href')
            href = str(href_attr) if href_attr else ''
            if 'download.apkpure.com' in href or 'd.apkpure.com' in href:
                if 'token' in href or 'key' in href:
                    return href
        
        iframe = soup.find('iframe', {'id': 'iframe_download'})
        if iframe:
            src_attr = iframe.get('src')
            if src_attr:
                return str(src_attr)
        
        meta_refresh = soup.find('meta', {'http-equiv': 'refresh'})
        if meta_refresh:
            content_attr = meta_refresh.get('content')
            content = str(content_attr) if content_attr else ''
            match = re.search(r'url=(.+)', content, re.IGNORECASE)
            if match:
                return match.group(1).strip()
        
        scripts = soup.find_all('script')
        for script in scripts:
            script_text = script.string or ''
            url_match = re.search(r'(https?://[^"\'<>\s]+\.(?:apk|xapk)[^"\'<>\s]*)', script_text, re.IGNORECASE)
            if url_match:
                return url_match.group(1)
        
        return None
        
    except Exception as e:
        print(f"[APKPure Resolve] {package_name}: {e}", file=sys.stderr)
        return None

def get_apkpure_info_sync(package_name: str) -> Optional[Dict[str, Any]]:
    """Use curl-cffi with Chrome impersonation to bypass CloudFlare"""
    try:
        chrome_versions = ["chrome110", "chrome116", "chrome120", "chrome124"]
        
        for chrome_ver in chrome_versions:
            try:
                xapk_url = f"https://d.apkpure.com/b/XAPK/{package_name}?version=latest"
                response = curl_requests.head(
                    xapk_url,
                    impersonate=chrome_ver,
                    timeout=30,
                    allow_redirects=True
                )
                
                if response.status_code == 200:
                    content_type = response.headers.get('Content-Type', '')
                    if 'html' not in content_type.lower():
                        content_length = int(response.headers.get('Content-Length', 0))
                        if content_length > 1000000:
                            print(f"[APKPure curl-cffi] Found XAPK for {package_name}: {content_length} bytes", file=sys.stderr)
                            return {
                                "source": "apkpure",
                                "download_url": xapk_url,
                                "size": content_length,
                                "file_type": "xapk",
                                "impersonate": chrome_ver
                            }
                
                apk_url = f"https://d.apkpure.com/b/APK/{package_name}?version=latest"
                response = curl_requests.head(
                    apk_url,
                    impersonate=chrome_ver,
                    timeout=30,
                    allow_redirects=True
                )
                
                if response.status_code == 200:
                    content_type = response.headers.get('Content-Type', '')
                    if 'html' not in content_type.lower():
                        content_length = int(response.headers.get('Content-Length', 0))
                        final_url = str(response.url)
                        
                        file_type = 'xapk' if 'xapk' in final_url.lower() else 'apk'
                        
                        if content_length > 100000:
                            print(f"[APKPure curl-cffi] Found {file_type.upper()} for {package_name}: {content_length} bytes", file=sys.stderr)
                            return {
                                "source": "apkpure",
                                "download_url": apk_url,
                                "size": content_length,
                                "file_type": file_type,
                                "impersonate": chrome_ver
                            }
                
                break
                
            except Exception as e:
                print(f"[APKPure curl-cffi] {chrome_ver} failed: {e}", file=sys.stderr)
                continue
        
        return None
    except Exception as e:
        print(f"[APKPure curl-cffi] {package_name}: {e}", file=sys.stderr)
        return None

async def get_apkpure_info(package_name: str) -> Optional[Dict[str, Any]]:
    """Async wrapper for curl-cffi APKPure download"""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, get_apkpure_info_sync, package_name)
    
    if result:
        return result
    
    try:
        client = get_client()
        xapk_url = f"https://d.apkpure.com/b/XAPK/{package_name}?version=latest"
        response = await client.head(xapk_url, headers=get_headers(), follow_redirects=True)
        
        if response.status_code == 200:
            content_type = response.headers.get('Content-Type', '')
            if 'html' not in content_type.lower():
                content_length = int(response.headers.get('Content-Length', 0))
                if content_length > 1000000:
                    return {
                        "source": "apkpure",
                        "download_url": xapk_url,
                        "size": content_length,
                        "file_type": "xapk"
                    }
        
        apk_url = f"https://d.apkpure.com/b/APK/{package_name}?version=latest"
        response = await client.head(apk_url, headers=get_headers(), follow_redirects=True)
        
        if response.status_code == 200:
            content_type = response.headers.get('Content-Type', '')
            if 'html' not in content_type.lower():
                content_length = int(response.headers.get('Content-Length', 0))
                final_url = str(response.url)
                
                file_type = 'apk'
                if 'xapk' in final_url.lower():
                    file_type = 'xapk'
                
                if content_length > 100000:
                    return {
                        "source": "apkpure",
                        "download_url": apk_url,
                        "size": content_length,
                        "file_type": file_type
                    }
        
        resolved_url = await resolve_apkpure_download_url(package_name, "XAPK")
        if resolved_url:
            try:
                check_response = await client.head(resolved_url, headers=get_headers(), follow_redirects=True)
                if check_response.status_code == 200:
                    content_type = check_response.headers.get('Content-Type', '')
                    content_length = int(check_response.headers.get('Content-Length', 0))
                    
                    if 'html' not in content_type.lower() or content_length > 1000000:
                        file_type = 'xapk' if 'xapk' in resolved_url.lower() else 'apk'
                        return {
                            "source": "apkpure",
                            "download_url": resolved_url,
                            "size": content_length,
                            "file_type": file_type
                        }
            except Exception as e:
                pass
        
        return None
    except Exception as e:
        print(f"[APKPure] {package_name}: {e}", file=sys.stderr)
        return None

async def get_download_info(package_name: str) -> Dict[str, Any]:
    stats["total_requests"] += 1
    cache_key = package_name
    now = time.time()
    
    if cache_key in url_cache:
        cached, timestamp = url_cache[cache_key]
        if now - timestamp < URL_CACHE_TTL:
            stats["cache_hits"] += 1
            print(f"[Cache Hit] {package_name} from {cached.get('source', 'unknown')}", file=sys.stderr)
            return cached
    
    # Primary and only source: APKPure
    result = await get_apkpure_info(package_name)
    
    # Last resort: Direct APKPure XAPK URL
    if not result:
        print(f"[Fallback] Using direct APKPure XAPK URL for {package_name}", file=sys.stderr)
        xapk_url = f"https://d.apkpure.com/b/XAPK/{package_name}?version=latest"
        result = {
            "source": "apkpure",
            "download_url": xapk_url,
            "size": 0,
            "file_type": "xapk"
        }
    
    result["package_name"] = package_name
    url_cache[cache_key] = (result, now)
    
    print(f"[Download Info] {package_name} -> Source: {result.get('source')}, Size: {result.get('size', 0)} bytes", file=sys.stderr)
    return result

@app.get("/info/{package_name}")
async def get_apk_info(package_name: str) -> Dict[str, Any]:
    try:
        info = await get_download_info(package_name)
        return {
            "package_name": package_name,
            "source": info.get("source"),
            "size": info.get("size", 0),
            "file_type": info.get("file_type", "apk"),
            "version": info.get("version", "Latest")
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/url/{package_name}")
async def get_download_url(package_name: str) -> Dict[str, Any]:
    try:
        info = await get_download_info(package_name)
        return {
            "success": True,
            "url": info['download_url'],
            "filename": f"{package_name}.{info.get('file_type', 'apk')}",
            "size": info.get('size', 0),
            "source": info.get('source'),
            "file_type": info.get('file_type', 'apk')
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/direct-url/{package_name}")
async def get_direct_download_url(package_name: str) -> Dict[str, Any]:
    """
    Returns the final download URL with headers needed to bypass CloudFlare.
    The client (axios) can use this to stream the file directly to the user.
    """
    try:
        info = await get_download_info(package_name)
        download_url = info['download_url']
        file_type = info.get('file_type', 'apk')
        
        headers_for_download = {
            'User-Agent': random.choice(USER_AGENTS),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Referer': 'https://apkpure.com/',
            'Origin': 'https://apkpure.com',
            'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-site',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        }
        
        return {
            "success": True,
            "url": download_url,
            "filename": f"{package_name}.{file_type}",
            "size": info.get('size', 0),
            "source": info.get('source'),
            "file_type": file_type,
            "headers": headers_for_download
        }
    except Exception as e:
        print(f"[Direct URL Error] {package_name}: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=str(e))

def download_with_curl_cffi(download_url: str, file_path: str, package_name: str) -> bool:
    """Download file using curl-cffi to bypass CloudFlare"""
    chrome_versions = ["chrome110", "chrome116", "chrome120", "chrome124"]
    
    for chrome_ver in chrome_versions:
        try:
            print(f"[curl-cffi] Downloading {package_name} with {chrome_ver}...", file=sys.stderr)
            response = curl_requests.get(
                download_url,
                impersonate=chrome_ver,
                timeout=300,
                allow_redirects=True
            )
            
            if response.status_code == 200:
                content_type = response.headers.get('Content-Type', '')
                if 'html' not in content_type.lower() or len(response.content) > 500000:
                    with open(file_path, 'wb') as f:
                        f.write(response.content)
                    file_size = os.path.getsize(file_path)
                    print(f"[curl-cffi] Downloaded {package_name}: {file_size / 1024 / 1024:.2f} MB", file=sys.stderr)
                    return True
            
            print(f"[curl-cffi] {chrome_ver} returned {response.status_code}", file=sys.stderr)
            
        except Exception as e:
            print(f"[curl-cffi] {chrome_ver} failed: {e}", file=sys.stderr)
            continue
    
    return False

async def download_file_to_cache(package_name: str, download_url: str, file_type: str) -> Optional[str]:
    lock = get_download_lock(package_name)
    
    async with lock:
        cache_key = f"{package_name}_{hashlib.md5(download_url.encode()).hexdigest()[:8]}"
        
        if cache_key in file_cache:
            cached_info = file_cache[cache_key]
            if os.path.exists(cached_info['file_path']):
                if cache_key in pending_deletions:
                    pending_deletions[cache_key].cancel()
                    del pending_deletions[cache_key]
                
                deletion_task = asyncio.create_task(schedule_file_deletion(cached_info['file_path'], 30))
                pending_deletions[cache_key] = deletion_task
                
                return cached_info['file_path']
        
        file_id = generate_user_file_id(package_name)
        file_path = os.path.join(DOWNLOADS_DIR, f"{file_id}.{file_type}")
        
        async with download_semaphore:
            stats["active_downloads"] += 1
            try:
                loop = asyncio.get_event_loop()
                success = await loop.run_in_executor(
                    None, 
                    download_with_curl_cffi, 
                    download_url, 
                    file_path, 
                    package_name
                )
                
                if not success:
                    print(f"[Download] curl-cffi failed, trying httpx...", file=sys.stderr)
                    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=30.0), follow_redirects=True) as client:
                        async with client.stream("GET", download_url, headers=get_headers()) as response:
                            if response.status_code != 200:
                                raise HTTPException(status_code=response.status_code, detail="Download failed")
                            
                            content_type = response.headers.get('Content-Type', '')
                            if 'html' in content_type.lower():
                                content = await response.aread()
                                if len(content) < 500000:
                                    raise HTTPException(status_code=400, detail="Got HTML instead of file")
                                async with aiofiles.open(file_path, 'wb') as f:
                                    await f.write(content)
                            else:
                                async with aiofiles.open(file_path, 'wb') as f:
                                    async for chunk in response.aiter_bytes(chunk_size=131072):
                                        await f.write(chunk)
                
                file_size = os.path.getsize(file_path)
                
                file_cache[cache_key] = {
                    'file_path': file_path,
                    'file_type': file_type,
                    'size': file_size,
                    'created_at': time.time()
                }
                stats["cached_files"] += 1
                stats["downloads"] += 1
                
                deletion_task = asyncio.create_task(schedule_file_deletion(file_path, 30))
                pending_deletions[cache_key] = deletion_task
                
                print(f"[Download] {package_name}: {file_size / 1024 / 1024:.2f} MB saved to cache", file=sys.stderr)
                return file_path
                
            except Exception as e:
                if os.path.exists(file_path):
                    os.remove(file_path)
                raise e
            finally:
                stats["active_downloads"] -= 1

@app.get("/download/{package_name}")
async def download_apk(package_name: str, background_tasks: BackgroundTasks, user_id: Optional[str] = None):
    try:
        info = await get_download_info(package_name)
        download_url = info['download_url']
        file_type = info.get('file_type', 'apk')
        
        file_path = await download_file_to_cache(package_name, download_url, file_type)
        
        if not file_path or not os.path.exists(file_path):
            raise HTTPException(status_code=500, detail="Failed to download file")
        
        filename = f"{package_name}.{file_type}"
        
        return FileResponse(
            path=file_path,
            filename=filename,
            media_type="application/vnd.android.package-archive",
            headers={
                "X-Source": str(info.get('source', 'apkpure')),
                "X-File-Type": file_type,
                "X-File-Size": str(os.path.getsize(file_path)),
                "Cache-Control": "no-cache"
            }
        )
            
    except HTTPException:
        raise
    except Exception as e:
        print(f"[Error] {package_name}: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/file/{package_name}")
async def get_cached_file(package_name: str):
    try:
        info = await get_download_info(package_name)
        download_url = info['download_url']
        file_type = info.get('file_type', 'apk')
        
        file_path = await download_file_to_cache(package_name, download_url, file_type)
        
        if not file_path or not os.path.exists(file_path):
            raise HTTPException(status_code=500, detail="Failed to get file")
        
        return {
            "success": True,
            "file_path": file_path,
            "file_type": file_type,
            "size": os.path.getsize(file_path),
            "package_name": package_name,
            "source": info.get('source')
        }
            
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/cache")
async def clear_cache():
    global url_cache, file_cache
    
    for task in pending_deletions.values():
        task.cancel()
    pending_deletions.clear()
    
    for filename in os.listdir(DOWNLOADS_DIR):
        try:
            os.remove(os.path.join(DOWNLOADS_DIR, filename))
        except:
            pass
    
    url_cache = {}
    file_cache = {}
    
    return {"status": "cache_cleared", "source": "apkpure"}

if __name__ == "__main__":
    uvicorn.run(app, host="localhost", port=8000, log_level="info", workers=1)
