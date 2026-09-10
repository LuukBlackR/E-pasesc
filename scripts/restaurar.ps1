# Restaura o sistema a partir de um snapshot de backup (banco de dados +
# arquivos). ACAO DESTRUTIVA: substitui os dados atuais pelos do snapshot
# escolhido - nao pode ser desfeita. Pensado para ser executado manualmente,
# nunca de forma agendada/automatica.
#
# Uso: powershell -ExecutionPolicy Bypass -File scripts\restaurar.ps1 -Snapshot "2026-09-07_12-00-00"
# Sem -Snapshot, lista os snapshots disponiveis e encerra.

param(
    [string]$Snapshot
)

Set-Location -Path (Join-Path $PSScriptRoot "..")

function Get-EnvValue($key, $default) {
    if (Test-Path ".env") {
        $line = Get-Content ".env" | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -Last 1
        if ($line) {
            $value = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")
            if ($value) { return $value }
        }
    }
    return $default
}

$backupRoot = Get-EnvValue "BACKUP_HOST_PATH" ".\backup"

if (-not $Snapshot) {
    Write-Host "Informe um snapshot com -Snapshot. Disponiveis em '$backupRoot':"
    Get-ChildItem -Path $backupRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Write-Host "  - $($_.Name)" }
    exit 1
}

$snapshotPath = Join-Path $backupRoot $Snapshot
$dbDumpPath = Join-Path $snapshotPath "database.sql"

if (-not (Test-Path $snapshotPath)) {
    Write-Error "Snapshot '$Snapshot' nao encontrado em '$backupRoot'."
    exit 1
}
if (-not (Test-Path $dbDumpPath)) {
    Write-Error "Este snapshot nao tem database.sql - nao e possivel restaurar o banco de dados."
    exit 1
}

Write-Host ""
Write-Host "ATENCAO: isso vai APAGAR os dados atuais do sistema (banco de dados e" -ForegroundColor Yellow
Write-Host "arquivos) e substituir pelo conteudo do snapshot '$Snapshot'." -ForegroundColor Yellow
Write-Host "Essa acao nao pode ser desfeita." -ForegroundColor Yellow
Write-Host ""
$confirm = Read-Host "Digite exatamente o nome do snapshot para confirmar"
if ($confirm -ne $Snapshot) {
    Write-Host "Confirmacao nao corresponde ao nome do snapshot. Restauracao cancelada."
    exit 1
}

# Impede que usuarios continuem usando o sistema com dados sendo trocados
# por baixo - so a API e parada; postgres e minio continuam de pe, pois os
# passos seguintes precisam deles.
Write-Host "Parando a API..."
docker compose stop api
if ($LASTEXITCODE -ne 0) {
    Write-Error "Nao foi possivel parar a API. Restauracao cancelada."
    exit 1
}

Write-Host "Limpando o banco de dados atual..."
docker compose exec -T postgres psql -U epasesc -d epasesc -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO epasesc; GRANT ALL ON SCHEMA public TO public;"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Falha ao limpar o banco de dados antes da restauracao. A API continua parada."
    exit 1
}

Write-Host "Restaurando banco de dados..."
Get-Content -Raw $dbDumpPath | docker compose exec -T postgres psql -U epasesc -d epasesc
if ($LASTEXITCODE -ne 0) {
    Write-Error "Falha ao restaurar o banco de dados. A API continua parada - verifique o erro acima antes de reinicia-la."
    exit 1
}

Write-Host "Restaurando arquivos no MinIO..."
docker compose run --rm api node src/restore.js "$Snapshot"
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Alguns arquivos podem nao ter sido restaurados - veja as mensagens acima."
}

Write-Host "Reiniciando a API..."
docker compose start api

Write-Host ""
Write-Host "Restauracao do snapshot '$Snapshot' concluida." -ForegroundColor Green
