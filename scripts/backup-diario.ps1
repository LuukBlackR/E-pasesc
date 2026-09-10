# Executa o backup diario completo: dump do banco de dados (PostgreSQL) e
# espelho dos arquivos (mesma estrutura de pastas/subpastas do app), os dois
# dentro da mesma pasta com data/hora, no destino configurado em
# BACKUP_HOST_PATH (.env). Feito para ser chamado pelo Agendador de Tarefas
# do Windows - nao e executado automaticamente sozinho.

Set-Location -Path (Join-Path $PSScriptRoot "..")

# Le BACKUP_HOST_PATH diretamente do .env, para garantir que o dump do
# banco e o log fiquem exatamente no mesmo lugar que o backup de arquivos
# (que e gravado pelo container usando essa mesma variavel).
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
$snapshot = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$snapshotPath = Join-Path $backupRoot $snapshot
$logFile = Join-Path $backupRoot "backup-log.txt"

New-Item -ItemType Directory -Force -Path $snapshotPath | Out-Null

function Log($message) {
    $line = "[$snapshot] $message"
    Write-Output $line
    Add-Content -Path $logFile -Value $line
}

try {
    $ErrorActionPreference = "Stop"
    Log "Iniciando backup em '$backupRoot'..."

    # Importante: comandos externos como "docker" NAO disparam uma excecao
    # do PowerShell quando falham (try/catch nao pega) - por isso o codigo
    # de saida ($LASTEXITCODE) e checado explicitamente depois de cada
    # chamada, em vez de confiar em try/catch para esses comandos.

    $dumpOutput = & docker compose exec -T postgres pg_dump -U epasesc -d epasesc --clean --if-exists 2> (Join-Path $snapshotPath "pg_dump-erro.log")
    if ($LASTEXITCODE -eq 0) {
        $dumpOutput | Out-File -Encoding utf8 (Join-Path $snapshotPath "database.sql")
        Remove-Item (Join-Path $snapshotPath "pg_dump-erro.log") -ErrorAction SilentlyContinue
        Log "Backup do banco de dados concluido."
    } else {
        Log "ERRO no backup do banco de dados (codigo de saida $LASTEXITCODE). Detalhes em $snapshotPath\pg_dump-erro.log"
    }

    $filesOutput = & docker compose exec -T api node src/backup.js "$snapshot" 2>&1
    $filesOutput | ForEach-Object { Log $_ }
    if ($LASTEXITCODE -ne 0) {
        Log "ERRO no backup dos arquivos (codigo de saida $LASTEXITCODE)."
    }
} catch {
    Log "ERRO inesperado no script de backup: $_"
} finally {
    Log "Backup finalizado."
}
