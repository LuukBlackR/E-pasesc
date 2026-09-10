import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// =============================================================================
// Configuração do cliente S3 (MinIO)
// =============================================================================
// Dois "mundos" de endereço são necessários porque o upload/download
// acontece direto entre o NAVEGADOR do usuário e o MinIO (via URL
// pré-assinada), enquanto a exclusão de objetos é uma chamada real feita
// pela própria API:
//   - S3_ENDPOINT: endereço interno (rede Docker), usado para chamadas reais
//     feitas pela API (ex.: excluir objeto, montar um .zip).
//   - endereço público: alcançável pelo NAVEGADOR (que pode estar em
//     qualquer dispositivo da rede — celular, notebook, outro computador).
//     Em vez de um único valor fixo no .env, a URL pública é montada
//     dinamicamente a partir do mesmo host que o navegador usou para
//     acessar o site (ex.: se alguém abriu http://192.168.15.10, o MinIO é
//     assinado em http://192.168.15.10:9000). Isso faz o upload/download
//     funcionar automaticamente em qualquer dispositivo da rede, sem
//     precisar configurar um IP fixo por máquina.

const credentials = {
  accessKeyId: process.env.S3_ACCESS_KEY,
  secretAccessKey: process.env.S3_SECRET_KEY,
};

const region = process.env.S3_REGION;
const bucket = process.env.S3_BUCKET;

const client = new S3Client({
  region,
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials,
});

// Endpoint público "estático", usado como último recurso quando não é
// possível derivar o host a partir da requisição (ex.: chamado fora de uma
// rota HTTP) — mantido por compatibilidade com S3_PUBLIC_ENDPOINT antigo.
const staticPublicClient = new S3Client({
  region,
  endpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials,
});

// Monta a URL base pública a partir da própria requisição HTTP: mesmo
// protocolo/host que o navegador usou, na porta pública do MinIO.
export function publicOriginFromRequest(req) {
  const port = process.env.S3_PUBLIC_PORT || '9000';
  return `${req.protocol}://${req.hostname}:${port}`;
}

function clientFor(originBase) {
  if (!originBase) return staticPublicClient;
  return new S3Client({ region, endpoint: originBase, forcePathStyle: true, credentials });
}

// =============================================================================
// Funções de armazenamento
// =============================================================================

export async function uploadUrl(key, contentType, originBase) {
  return getSignedUrl(
    clientFor(originBase),
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: 300 }
  );
}

export async function downloadUrl(key, originBase) {
  return getSignedUrl(
    clientFor(originBase),
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 300 }
  );
}

export async function deleteObject(key) {
  return client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// Usado apenas pela API internamente (ex.: montar um .zip de uma pasta) —
// por isso usa o cliente interno, não o público.
export async function getObjectStream(key) {
  const output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return output.Body;
}

// Upload direto (sem URL pré-assinada) — usado pela restauração de backup,
// que reenvia cada arquivo para a chave original registrada no manifesto.
export async function putObject(key, body, contentType) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}
