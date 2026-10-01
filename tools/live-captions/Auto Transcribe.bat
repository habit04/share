@echo off
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
python auto_transcribe.py %*
pause
