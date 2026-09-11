@echo off
chcp 65001 >nul
set "SRC=C:\Users\admin\AppData\Local\Temp\review_working.docx"
set "SRC2=F:\Claude code本地文件\office-agent-web\zz_review_working.docx"
set "DST=E:\老电脑文件\工作\义乌十五五物流\金华（义乌）国际枢纽港海陆联动开放提升战略研究-研究报告20241113.docx"
if exist "%SRC%" (set USE=%SRC%) else (set USE=%SRC2%)
echo 源文件: %USE%
echo 目标: %DST%
echo 正在备份原文件...
copy /Y "%DST%" "%DST%.bak" >nul 2>&1
echo 正在覆盖（需要管理员权限）...
copy /Y "%USE%" "%DST%"
if %ERRORLEVEL%==0 (echo [OK] 批注已覆盖到工作区，请刷新浏览器查看) else (echo [FAIL] 无写入权限，请以管理员身份运行本脚本)
pause
