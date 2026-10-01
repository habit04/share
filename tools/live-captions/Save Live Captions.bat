@echo off
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
python save_live_captions.py %*
pause
