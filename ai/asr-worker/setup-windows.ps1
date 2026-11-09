# SPlayer AI - Qwen3-ASR one-time setup for Windows 11 (run in PowerShell)
# Prereqs: Python 3.12 x64 on PATH, NVIDIA driver, internet (proxy supported)
# Usage:  powershell -ExecutionPolicy Bypass -File ai\asr-worker\setup-windows.ps1

$ErrorActionPreference = "Stop"
$Root = "E:\aitools\qwen3-asr"   # IMPORTANT: ASCII-only path (dynet cannot read non-ASCII paths)

Write-Host "==> 1/4 create venv at $Root"
python -m venv "$Root\venv"
$py = "$Root\venv\Scripts\python.exe"

Write-Host "==> 2/4 install torch cu126 (about 2.5GB, cached after first run)"
& $py -m pip install -U pip
& $py -m pip install torch --index-url https://download.pytorch.org/whl/cu126

Write-Host "==> 3/4 install qwen-asr + modelscope"
& $py -m pip install -r (Join-Path $PSScriptRoot "requirements.txt")

Write-Host "==> 4/4 download Qwen3-ASR-0.6B (about 1.8GB)"
& $py -c "from modelscope import snapshot_download; snapshot_download('Qwen/Qwen3-ASR-0.6B', local_dir=r'$Root\models\Qwen3-ASR-0.6B')"

Write-Host ""
Write-Host "SETUP DONE. Configure in SPlayer:"
Write-Host "  Settings -> AI -> engine = Qwen3-ASR"
Write-Host "  Python path  = $Root\venv\Scripts\python.exe"
Write-Host "  Model dir    = $Root\models\Qwen3-ASR-0.6B"
