@echo off
echo Menjalankan sinkronisasi Git & Clasp...
git add .
git commit -m "update otomatis"
git push
clasp push
echo Selesai! Semua file berhasil disinkronkan.
pause