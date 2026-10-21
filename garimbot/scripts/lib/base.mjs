// Base do Garimbot: pastas, configuração, memória (data/) e registro de
// auditoria. Portátil: nada de caminho fixo da máquina (tudo relativo à
// pasta da agência).
import { readFile, writeFile, mkdir, rename, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lerYaml } from "./yaml.mjs";

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// GARIMBOT_DATA / GARIMBOT_RELATORIOS: só para os testes (memória numa pasta temporária)
export const DATA = process.env.GARIMBOT_DATA ? path.resolve(process.env.GARIMBOT_DATA) : path.join(RAIZ, "data");
export const RELATORIOS = process.env.GARIMBOT_RELATORIOS ? path.resolve(process.env.GARIMBOT_RELATORIOS) : path.join(RAIZ, "relatorios");

export async function config(nome) {
  return lerYaml(await readFile(path.join(RAIZ, "config", nome + ".yml"), "utf8"));
}
export async function configs() {
  const [temas, projetos, criterios, agendamento, limites, agentes, kits] = await Promise.all(
    ["temas", "projetos", "criterios", "agendamento", "limites", "agentes", "kits"].map(config),
  );
  return { temas, projetos, criterios, agendamento, limites, agentes, kits };
}

// .garimbot/ na raiz da agência (decisão do dono, docs/CONTINUIDADE.md): o Guard
// (.claude/hooks/garimbot-guard.mjs) lê aprovados.json daqui e só libera o clone
// "git clone -c garimbot.audit=1 <url> .garimbot/quarentena/<nome>".
// A quarentena é ignorada pelo Git. GARIMBOT_PASTA muda a pasta (só nos testes).
export const AGENCIA = path.resolve(RAIZ, "..");
export const pastaGuard = (env = process.env) =>
  env.GARIMBOT_PASTA ? path.resolve(env.GARIMBOT_PASTA) : path.join(AGENCIA, ".garimbot");
export const pastas = (env = process.env) => {
  const g = pastaGuard(env);
  return {
    guard: g,
    aprovados: path.join(g, "aprovados.json"),
    quarentena: path.join(g, "quarentena"),
    // resultados brutos e pacotes de revisão também são dado de terceiros: ficam na quarentena
    execucoes: path.join(g, "quarentena", "_execucoes"),
  };
};

// memória em JSON: grava num arquivo temporário e troca (nunca fica pela metade)
export async function lerJson(arquivo, padrao) {
  try {
    return JSON.parse(await readFile(arquivo, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && padrao !== undefined) return structuredClone(padrao);
    throw e;
  }
}
export async function gravarJson(arquivo, dados) {
  await mkdir(path.dirname(arquivo), { recursive: true });
  const tmp = arquivo + "." + process.pid + ".tmp";
  await writeFile(tmp, JSON.stringify(dados, null, 2) + "\n");
  await rename(tmp, arquivo);
}
export const memoria = (nome) => path.join(DATA, nome + ".json");

// registro de auditoria: uma linha JSON por decisão, um arquivo por mês
export async function registrar(evento, agora = new Date()) {
  const arq = path.join(DATA, "auditoria-log", agora.toISOString().slice(0, 7) + ".jsonl");
  await mkdir(path.dirname(arq), { recursive: true });
  await appendFile(arq, JSON.stringify({ em: agora.toISOString(), ...evento }) + "\n");
}

export const idExecucao = (tema, agora = new Date()) =>
  agora.toISOString().slice(0, 10) +
  "-" +
  String(tema || "analise")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) +
  "-" +
  agora.toISOString().slice(11, 19).replace(/:/g, "");

// nome "dono/repo" válido do GitHub (nunca vira caminho fora da pasta)
export function nomeRepo(v) {
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(
    String(v ?? "").trim(),
  );
  if (!m || m[2] === "." || m[2] === "..") throw new Error("Repositório inválido: " + v);
  return m[1] + "/" + m[2];
}
// pasta segura para qualquer item (repositório "dono/repo" ou pacote "npm:x@1.0.0")
export const pastaDoRepo = (nome) => nome.replace("/", "__").replace(/[^A-Za-z0-9._@-]/g, "_");
export const existe = (p) => existsSync(p);
