$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = 'C:\Users\zihua\AppData\Local\Programs\Python\Python310\python.exe'
# Construct the Chinese filename from code points so Windows PowerShell 5
# handles this UTF-8 script correctly even when it is read without a BOM.
$name = 'IOI AI ' + (-join ([char[]](0x5F69, 0x7968, 0x91CF, 0x5316, 0x9884, 0x6D4B, 0x7CFB, 0x7EDF)))
$templates = Join-Path $project 'templates'
$static = Join-Path $project 'static'
$reports = Join-Path $project 'reports'
$icon = Join-Path $static 'ioi-logo.ico'
$versionInfo = Join-Path $project 'windows_version_info.txt'

if (-not (Test-Path -LiteralPath $python)) {
    throw "未找到用于打包的 Python 3.10：$python"
}

Push-Location $project
try {
    & $python -m PyInstaller `
        --noconfirm `
        --clean `
        --onefile `
        --windowed `
        --name $name `
        --icon $icon `
        --version-file $versionInfo `
        --add-data "$templates;templates" `
        --add-data "$static;static" `
        --add-data "$reports;reports" `
        --hidden-import 'ssq_predict' `
        --hidden-import 'ssq_adaptive_predictor' `
        --hidden-import 'dlt_predict' `
        --hidden-import 'dlt_adaptive_predictor' `
        --hidden-import 'single_ticket_ensemble' `
        --exclude-module 'PyQt5' `
        --exclude-module 'PyQt6' `
        --exclude-module 'qtpy' `
        --exclude-module 'gi' `
        --exclude-module 'cefpython3' `
        --distpath 'dist' `
        --workpath 'build\windows-app' `
        --specpath 'build' `
        'desktop_app.py'

    if ($LASTEXITCODE -ne 0) {
        throw "Windows app build failed with exit code $LASTEXITCODE"
    }

    $built = Join-Path $project "dist\$name.exe"
    $target = Join-Path $project "$name.exe"
    try {
        Copy-Item -LiteralPath $built -Destination $target -Force
        Write-Host "已生成：$target"
    }
    catch {
        # 正在运行的单文件应用会锁定自身；保留旧进程并输出可直接使用的新版本。
        $fallback = Join-Path $project "$name-统计修复版.exe"
        Copy-Item -LiteralPath $built -Destination $fallback -Force
        Write-Host "主程序正在运行，已生成旁路更新版：$fallback"
    }
}
finally {
    Pop-Location
}
