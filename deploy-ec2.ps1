# Deploy Discord bot to AWS EC2 via SCP
# 1. Set your EC2 details below (one time)
# 2. Run: .\deploy-ec2.ps1

# ----- EDIT THESE -----
$KEY_PATH = "D:\teamspeak-server\teamspeak-key.pem"   # e.g. C:\Users\haris\.ssh\my-ec2-key.pem
$EC2_HOST = "ec2-user@43.205.113.19"    # Ubuntu use: ubuntu@YOUR_PUBLIC_IP
$REMOTE_DIR = "~/discord-bot"
# ----------------------

$ProjectRoot = $PSScriptRoot
$Exclude = @("node_modules", ".env", ".git")

# Create temp folder and copy project (excluding node_modules, .env)
$TempDir = Join-Path $env:TEMP "discord-bot-deploy"
if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }
New-Item -ItemType Directory -Path $TempDir | Out-Null

Get-ChildItem $ProjectRoot -Force | Where-Object {
    $name = $_.Name
    $Exclude -notcontains $name
} | ForEach-Object {
    Copy-Item $_.FullName -Destination $TempDir -Recurse -Force
}

Write-Host "Uploading to $EC2_HOST ..." -ForegroundColor Cyan
& scp -i $KEY_PATH -r "$TempDir\*" "${EC2_HOST}:${REMOTE_DIR}/"
$err = $LASTEXITCODE
Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue

if ($err -eq 0) {
    Write-Host "Done. On the server run: cd discord-bot && npm install && cp .env.example .env && nano .env" -ForegroundColor Green
} else {
    Write-Host "Upload failed. Check KEY_PATH and EC2_HOST, and that SSH works: ssh -i `"$KEY_PATH`" $EC2_HOST" -ForegroundColor Red
}
