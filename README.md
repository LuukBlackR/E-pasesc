# E-Pasesc — Pasta Escolar Eletrônica

Sistema de gestão de arquivos escolares com controle de acesso por
hierarquia, aprovação de cadastros e visibilidade configurável por pasta.
Desenvolvido para uso interno de uma escola, com organização de documentos
pedagógicos (turmas/disciplinas) e administrativos (secretaria).

## Tecnologias

- **Backend:** Node.js, Express, Prisma ORM
- **Banco de dados:** PostgreSQL
- **Armazenamento de arquivos:** MinIO (compatível com S3), via URLs pré-assinadas
- **Frontend:** HTML, CSS e JavaScript (sem framework/build step)
- **Infraestrutura:** Docker Compose, NGINX como proxy reverso
- **Autenticação:** cookies HttpOnly + JWT, senhas com hash Argon2id

## Funcionalidades

- Login por nome de usuário (gerado automaticamente a partir do nome
  completo) e senha, com opção de "esqueci minha senha".
- Cadastro de usuários com fluxo de aprovação: toda conta nova fica
  pendente até ser aprovada pela secretaria ou administração.
- Perfis de acesso hierárquicos: Administração, Secretaria e Professor.
- Organização de pastas em duas áreas (Pedagógico e Secretaria/Administração),
  com subpastas e visibilidade configurável por perfil.
- Upload, download, renomeação e exclusão de documentos, com validação de
  tipo e tamanho de arquivo.
- Download de uma pasta inteira em `.zip`, respeitando a visibilidade de
  cada subpasta e arquivo.
- Log de auditoria completo (quem fez o quê, quando, e em qual pasta ou
  arquivo), com filtros e exportação em `.csv`/`.xlsx`.
- Upload de foto de perfil.
- Acesso de qualquer dispositivo na mesma rede local (celular, notebook,
  outro computador), sem configuração manual por máquina.
- Backup diário automatizado: espelha em disco a mesma estrutura de
  pastas/subpastas navegada no app, além de um dump completo do banco de
  dados, em um destino configurável (`BACKUP_HOST_PATH`) — com script de
  restauração completa a partir de qualquer snapshot.

## Estrutura do projeto

```
.
├── backend/
│   ├── src/
│   │   ├── server.js         # Rotas da API, autenticação, RBAC, auditoria
│   │   ├── permissions.js    # Regras de hierarquia e visibilidade de pastas
│   │   ├── prisma.js         # Cliente Prisma
│   │   ├── storage.js        # Integração com MinIO/S3 (URLs pré-assinadas)
│   │   ├── backup.js         # Backup: espelha pastas/arquivos em disco
│   │   └── restore.js        # Restauração: reenvia arquivos ao MinIO
│   ├── prisma/schema.prisma  # Modelo de dados
│   ├── Dockerfile
│   └── docker-entrypoint.sh
├── frontend/
│   ├── index.html            # Landing page, login/cadastro e painel principal
│   ├── app.js
│   └── styles.css
├── images/                   # Identidade visual
├── nginx/
│   └── default.conf          # Proxy reverso e servidor do frontend
├── scripts/
│   ├── backup-diario.ps1     # Rotina de backup (banco + arquivos)
│   └── restaurar.ps1         # Restauração a partir de um snapshot
├── docker-compose.yml
└── .env.example
```

## Pré-requisitos

- [Docker](https://www.docker.com/) e Docker Compose

Nenhuma outra dependência precisa ser instalada manualmente — Node.js,
PostgreSQL e MinIO rodam dentro dos containers.

## Como executar

```bash
cp .env.example .env
# edite o .env com valores próprios (ver seção abaixo)

docker compose up --build
```

A aplicação fica disponível em `http://localhost`. Na primeira execução, o
schema do banco é sincronizado automaticamente e o bucket do MinIO é criado
já configurado como privado.

## Variáveis de ambiente

Definidas em `.env` (veja `.env.example` para o modelo). Todas as senhas e
segredos devem ser substituídas por valores próprios antes de qualquer uso
real — os valores de exemplo não são seguros.

| Variável | Descrição |
|---|---|
| `POSTGRES_PASSWORD` | Senha do banco PostgreSQL |
| `DATABASE_URL` | String de conexão do Prisma com o PostgreSQL |
| `JWT_SECRET` | Chave usada para assinar os tokens de sessão |
| `APP_ORIGIN` | Origens adicionais liberadas no CORS (opcional; IPs de rede local já são liberados automaticamente) |
| `S3_ENDPOINT` | Endereço interno do MinIO, usado pela API dentro da rede Docker |
| `S3_PUBLIC_PORT` | Porta do MinIO exposta ao host, usada para montar as URLs de upload/download acessadas pelo navegador |
| `S3_REGION` | Região usada pelo cliente S3 (qualquer valor válido, o MinIO não valida) |
| `S3_BUCKET` | Nome do bucket privado usado para os arquivos |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Credenciais de acesso ao MinIO |
| `LOG_LEVEL` | Nível de log da API (`info`, `warn`, `error`, etc.) |

## Backup e restauração

O sistema faz backup diário automatizado (banco de dados + arquivos, na
mesma estrutura de pastas navegada no app) através de dois scripts em
`scripts/`, chamados pelo Agendador de Tarefas do Windows. O destino é
definido por `BACKUP_HOST_PATH` no `.env`.

### Backup (`scripts/backup-diario.ps1`)

Executa o dump do banco (`pg_dump --clean --if-exists`, o que torna a
restauração segura mesmo sobre um banco já existente) e o espelho de
arquivos, gravando os dois na mesma pasta com data/hora, dentro do destino
configurado.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup-diario.ps1
```

Para automatizar, registre esse comando no Agendador de Tarefas do Windows
com a frequência desejada (marque "Executar mesmo que o usuário não esteja
conectado"). Cada execução grava um snapshot completo, sem limite de
retenção — o espaço em disco deve ser monitorado manualmente.

### Restauração (`scripts/restaurar.ps1`)

Restaura o sistema a partir de um snapshot específico. **Ação destrutiva**:
substitui os dados atuais pelos do snapshot escolhido e não pode ser
desfeita — por isso pede confirmação explícita (digitar o nome do
snapshot) e nunca deve ser agendada, só executada manualmente quando
necessário.

```powershell
# Lista os snapshots disponíveis
powershell -ExecutionPolicy Bypass -File scripts\restaurar.ps1

# Restaura um snapshot específico
powershell -ExecutionPolicy Bypass -File scripts\restaurar.ps1 -Snapshot "2026-09-07_12-00-00"
```

O script para a API antes de restaurar (evita que alguém use o sistema com
os dados sendo trocados por baixo), restaura o banco de dados, reenvia cada
arquivo para o MinIO na chave original (usando o `manifest.json` gerado no
backup) e reinicia a API ao final.

## Segurança

- Senhas de usuário com hash Argon2id.
- Cookies de sessão HttpOnly, `SameSite=Lax`, com o atributo `Secure`
  aplicado automaticamente apenas quando a conexão é HTTPS.
- Cabeçalhos HTTP de segurança via Helmet e NGINX.
- Rate limiting nas rotas de autenticação e na API em geral.
- Bucket do MinIO privado, sem acesso anônimo; arquivos só são acessíveis
  por URLs assinadas com expiração curta.
- Autocadastro público nunca concede o perfil de Administrador; toda conta
  nova passa por aprovação antes de poder ser usada.
