#!/usr/bin/env python3
import sys
import os
import cloudscraper
from bs4 import BeautifulSoup
import re
import time

def download_apk(package_name):
    scraper = cloudscraper.create_scraper(
        browser={
            'browser': 'chrome',
            'platform': 'windows',
            'desktop': True
        }
    )
    
    try:
        app_url = f"https://apkpure.com/{package_name}/{package_name}"
        
        print(f"جاري الوصول إلى: {app_url}", file=sys.stderr)
        response = scraper.get(app_url, timeout=30)
        
        if response.status_code != 200:
            print(f"خطأ في الوصول للصفحة: {response.status_code}", file=sys.stderr)
            return None
        
        soup = BeautifulSoup(response.content, 'lxml')
        
        download_link = None
        
        download_btn = soup.find('a', class_=re.compile(r'download.*btn|btn.*download', re.I))
        if not download_btn:
            download_btn = soup.find('a', href=re.compile(r'/download'))
        
        if download_btn and download_btn.get('href'):
            download_url = str(download_btn.get('href', ''))
            
            if download_url.startswith('/'):
                download_url = 'https://apkpure.com' + download_url
            
            print(f"رابط التحميل: {download_url}", file=sys.stderr)
            
            dl_response = scraper.get(download_url, timeout=15)
            dl_soup = BeautifulSoup(dl_response.content, 'lxml')
            
            direct_link = dl_soup.find('a', {'id': 'download_link'})
            if direct_link and direct_link.get('href'):
                download_link = str(direct_link.get('href', ''))
            else:
                iframe = dl_soup.find('iframe', {'id': 'iframe_download'})
                if iframe and iframe.get('src'):
                    download_link = str(iframe.get('src', ''))
                else:
                    meta_refresh = dl_soup.find('meta', {'http-equiv': 'refresh'})
                    if meta_refresh:
                        content = str(meta_refresh.get('content', ''))
                        match = re.search(r'url=(.+)', content)
                        if match:
                            download_link = match.group(1)
        
        if not download_link:
            print("لم يتم العثور على رابط تحميل مباشر", file=sys.stderr)
            
            alternate_url = f"https://d.apkpure.com/b/APK/{package_name}?version=latest"
            print(f"جاري المحاولة مع رابط بديل: {alternate_url}", file=sys.stderr)
            download_link = alternate_url
        
        if download_link:
            print(f"جاري تحميل الملف من: {download_link}", file=sys.stderr)
            
            file_response = scraper.get(download_link, timeout=60, stream=True)
            
            if file_response.status_code == 200:
                content_type = file_response.headers.get('Content-Type', '')
                
                if 'html' in content_type.lower():
                    print("الرابط يشير إلى صفحة HTML وليس ملف APK", file=sys.stderr)
                    return None
                
                file_name = f"{package_name}.apk"
                
                content_disposition = file_response.headers.get('content-disposition', '')
                if content_disposition:
                    filename_match = re.search(r'filename[^;=\n]*=(([\'"]).*?\2|[^;\n]*)', content_disposition)
                    if filename_match:
                        file_name = filename_match.group(1).strip('\'"')
                
                if '.xapk' in download_link.lower() or 'xapk' in content_type.lower():
                    file_name = file_name.replace('.apk', '.xapk')
                elif '.apks' in download_link.lower():
                    file_name = file_name.replace('.apk', '.apks')
                
                download_dir = os.path.join(os.path.dirname(__file__), 'downloads')
                os.makedirs(download_dir, exist_ok=True)
                
                file_path = os.path.join(download_dir, file_name)
                
                print(f"جاري حفظ الملف: {file_path}", file=sys.stderr)
                
                with open(file_path, 'wb') as f:
                    for chunk in file_response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                
                file_size = os.path.getsize(file_path)
                print(f"تم التحميل بنجاح! الحجم: {file_size / (1024*1024):.2f} MB", file=sys.stderr)
                
                print(file_path)
                return file_path
            else:
                print(f"فشل تحميل الملف: {file_response.status_code}", file=sys.stderr)
                return None
        else:
            print("لم يتم العثور على رابط تحميل", file=sys.stderr)
            return None
            
    except Exception as e:
        print(f"خطأ: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("الاستخدام: python3 scrap.py <package_name>", file=sys.stderr)
        sys.exit(1)
    
    package_name = sys.argv[1]
    result = download_apk(package_name)
    
    if not result:
        sys.exit(1)
