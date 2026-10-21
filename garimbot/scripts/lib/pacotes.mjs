// Porteiro de pacotes (npm e PyPI): baixa o pacote na quarentena, confere a
// integridade publicada pelo registro, extrai com segurança (nada fora da
// pasta, nada executado) e devolve os dados para a mesma auditoria dos
// repositórios. Aprovado vira item {tipo: "npm"|"pypi", nome, versao} no
// .garimbot/aprovados.json, o formato que o Guard libera (npm install x@versão).
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile, readdir, rename, readFile } from "node:fs/promises";
import path from "node:path";
import { rodar } from "./ferramentas.mjs";

const NPM = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213})(?:@([0-9A-Za-z.+-]{1,64}))?$/;
const PYPI = /^pypi:([A-Za-z0-9][A-Za-z0-9._-]{0,99})(?:==([0-9A-Za-z.+!-]{1,64}))?$/;
export const ehPacote = (v) => /^(npm|pypi):/.test(String(v ?? "").trim());

// "npm:nome@1.2.3" ou "pypi:nome==1.2.3" (sem versão: a mais recente, resolvida na hora)
export function lerSpec(v) {
  const s = String(v ?? "").trim();
  let m = NPM.exec(s);
  if (m) return { tipo: "npm", pacote: m[1], versao: m[2] ?? null };
  m = PYPI.exec(s);
  if (m) return { tipo: "pypi", pacote: m[1].toLowerCase().replace(/[._]+/g, "-"), versao: m[2] ?? null };
  throw new Error("Pacote inválido: " + v + ' (use npm:nome@versão ou pypi:nome==versão)');
}
export const nomePacote = ({ tipo, pacote, versao }) => (tipo === "npm" ? `npm:${pacote}@${versao}` : `pypi:${pacote}==${versao}`);

async function json(url, fetcher) {
  const r = await fetcher(url, { headers: { Accept: "application/json", "User-Agent": "garimbot" } });
  if (!r.ok) throw new Error(`registro respondeu ${r.status}`);
  return r.json();
}
const dias = (iso, agora) => (iso ? (agora - Date.parse(iso)) / 864e5 : null);

// dados do registro (sem baixar código) e pré-filtro do pacote
export async function dadosDoPacote(spec, { fetcher = fetch, agora = Date.now() } = {}) {
  if (spec.tipo === "npm") {
    const nomeUrl = spec.pacote.replace("/", "%2F");
    const doc = await json(`https://registry.npmjs.org/${nomeUrl}`, fetcher);
    const versao = spec.versao ?? doc["dist-tags"]?.latest;
    const v = doc.versions?.[versao];
    if (!v) throw new Error(`versão ${versao} não existe no npm`);
    const repo = String(v.repository?.url ?? doc.repository?.url ?? "");
    // procedência (8.14, item 6): atestado do npm = publicado pelo CI daquele repositório
    const atestado = Boolean(v.dist?.attestations?.provenance);
    return {
      tipo: "npm", pacote: spec.pacote, versao, nome: nomePacote({ ...spec, versao }),
      url: `https://www.npmjs.com/package/${spec.pacote}/v/${versao}`,
      descricao: String(v.description ?? "").slice(0, 300),
      licenca: typeof v.license === "string" ? v.license : v.license?.type ?? null,
      publicado: doc.time?.[versao] ?? null, criado: doc.time?.created ?? null,
      descontinuado: v.deprecated ? String(v.deprecated).slice(0, 200) : null,
      repositorio: repo.replace(/^git\+/, "").replace(/\.git$/, "") || null,
      mantenedores: (v.maintainers ?? []).length,
      arquivo: { url: v.dist?.tarball, integridade: v.dist?.integrity ?? null, sha1: v.dist?.shasum ?? null, formato: "tgz" },
      scripts_instalacao: Object.keys(v.scripts ?? {}).filter((s) => /^(pre|post)?install$|^prepare$/.test(s)),
      procedencia: atestado ? "verificada (atestado de procedência do npm)" : repo ? "não verificada: o repositório é só declarado pelo autor" : "sem repositório declarado",
      _dias: dias(doc.time?.[versao], agora),
    };
  }
  const doc = await json(`https://pypi.org/pypi/${spec.pacote}/${spec.versao ? spec.versao + "/" : ""}json`, fetcher);
  const versao = spec.versao ?? doc.info?.version;
  const arqs = doc.urls ?? [];
  const sdist = arqs.find((a) => a.packagetype === "sdist" && /\.tar\.gz$/.test(a.filename));
  const wheel = arqs.find((a) => a.packagetype === "bdist_wheel" && /-none-any\.whl$/.test(a.filename)) ?? arqs.find((a) => a.packagetype === "bdist_wheel");
  const a = sdist ?? wheel;
  return {
    tipo: "pypi", pacote: spec.pacote, versao, nome: nomePacote({ ...spec, versao }),
    url: `https://pypi.org/project/${spec.pacote}/${versao}/`,
    descricao: String(doc.info?.summary ?? "").slice(0, 300),
    licenca: doc.info?.license_expression || (doc.info?.license && doc.info.license.length < 60 ? doc.info.license : null) ||
      (doc.info?.classifiers ?? []).find((c) => c.startsWith("License ::"))?.split("::").pop().trim() || null,
    publicado: a?.upload_time_iso_8601 ?? null, criado: null,
    descontinuado: doc.info?.yanked ? "versão retirada (yanked): " + (doc.info.yanked_reason ?? "") : null,
    repositorio: doc.info?.project_urls?.Source ?? doc.info?.project_urls?.Repository ?? null,
    mantenedores: null,
    arquivo: a ? { url: a.url, sha256: a.digests?.sha256 ?? null, formato: a.filename.endsWith(".whl") ? "zip" : "tgz" } : null,
    scripts_instalacao: [],
    procedencia: "não verificada (o PyPI não traz atestado nesta consulta)",
    _dias: dias(a?.upload_time_iso_8601, agora),
  };
}

// o que o pré-filtro descartaria (pacote): descontinuado, sem licença, versão nova demais, nome imitado
export function prefiltroPacote(d, { versao_min_dias = 7, imitacao } = {}) {
  if (d.descontinuado) return "pacote descontinuado/retirado: " + d.descontinuado;
  if (!d.licenca) return "sem licença";
  if (!d.arquivo?.url) return "sem arquivo para baixar";
  if (d._dias != null && d._dias < versao_min_dias) return `versão publicada há menos de ${versao_min_dias} dias (espere ou audite de novo depois)`;
  const parecido = imitacao?.(d.pacote);
  if (parecido) return `nome parecido com ${parecido} (possível imitação)`;
  return null;
}

// só baixa de registros oficiais
const ORIGENS = /^https:\/\/(registry\.npmjs\.org|files\.pythonhosted\.org)\//;
const caminhoRuim = (p) => !p || p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes("..");

// .tgz: lista antes de extrair (nada de caminho absoluto, "..", links ou dispositivos)
async function extrairTgz(arquivo, destino) {
  const lista = await rodar("tar", ["-tvzf", arquivo], { timeoutMs: 120e3 });
  if (lista.codigo !== 0) throw new Error("não consegui ler o pacote: " + lista.err.slice(-200));
  const linhas = lista.out.split(/\r?\n/).filter(Boolean);
  if (linhas.length > 20000) throw new Error("pacote com arquivos demais");
  for (const l of linhas) if (/^[lhbcp]/.test(l)) throw new Error("pacote com link ou arquivo especial: " + l.slice(0, 120));
  const nomes = await rodar("tar", ["-tzf", arquivo], { timeoutMs: 120e3 });
  for (const n of nomes.out.split(/\r?\n/).filter(Boolean)) if (caminhoRuim(n)) throw new Error("caminho perigoso dentro do pacote: " + n.slice(0, 120));
  const ex = await rodar("tar", ["-xzf", arquivo, "-C", destino, "--no-same-owner", "--no-same-permissions"], { timeoutMs: 300e3 });
  if (ex.codigo !== 0) throw new Error("não consegui extrair: " + ex.err.slice(-200));
}
// .whl (zip): pelo zipfile do Python em modo isolado (ele mesmo descarta ".." e caminhos absolutos)
async function extrairZip(arquivo, destino) {
  for (const py of ["python3", "python", "py"]) {
    const l = await rodar(py, ["-I", "-m", "zipfile", "-l", arquivo], { timeoutMs: 120e3 });
    if (l.codigo !== 0) continue;
    const nomes = l.out.split(/\r?\n/).slice(1).map((x) => x.split(/\s{2,}/)[0]).filter(Boolean);
    if (nomes.length > 20000) throw new Error("pacote com arquivos demais");
    for (const n of nomes) if (caminhoRuim(n)) throw new Error("caminho perigoso dentro do pacote: " + n.slice(0, 120));
    const ex = await rodar(py, ["-I", "-m", "zipfile", "-e", arquivo, destino], { timeoutMs: 300e3 });
    if (ex.codigo !== 0) throw new Error("não consegui extrair: " + ex.err.slice(-200));
    return;
  }
  throw new Error("sem Python para abrir o pacote .whl");
}

// baixa, confere a integridade e extrai em `destino` (fica com a raiz do pacote)
export async function baixarPacote(d, destino, { fetcher = fetch, maxMb = 200 } = {}) {
  if (!ORIGENS.test(d.arquivo?.url ?? "")) throw new Error("endereço de download fora dos registros oficiais");
  await rm(destino, { recursive: true, force: true });
  await mkdir(destino, { recursive: true });
  const r = await fetcher(d.arquivo.url, { headers: { "User-Agent": "garimbot" } });
  if (!r.ok) throw new Error("download respondeu " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxMb * 1024 * 1024) throw new Error(`pacote grande demais (${Math.round(buf.length / 1e6)} MB)`);
  // integridade: sha512 (npm), sha1 (npm antigo) ou sha256 (PyPI)
  const integ = d.arquivo.integridade;
  if (integ?.startsWith("sha512-")) {
    if (createHash("sha512").update(buf).digest("base64") !== integ.slice(7)) throw new Error("integridade (sha512) não confere");
  } else if (d.arquivo.sha1) {
    if (createHash("sha1").update(buf).digest("hex") !== d.arquivo.sha1) throw new Error("integridade (sha1) não confere");
  } else if (d.arquivo.sha256) {
    if (createHash("sha256").update(buf).digest("hex") !== d.arquivo.sha256) throw new Error("integridade (sha256) não confere");
  } else throw new Error("registro sem hash de integridade");
  const arquivo = path.join(path.dirname(destino), path.basename(destino) + (d.arquivo.formato === "zip" ? ".zip" : ".tgz"));
  await writeFile(arquivo, buf);
  try {
    if (d.arquivo.formato === "zip") await extrairZip(arquivo, destino);
    else await extrairTgz(arquivo, destino);
  } finally {
    await rm(arquivo, { force: true });
  }
  // npm vem dentro de "package/", sdist dentro de "<nome>-<versão>/": sobe para a raiz
  const itens = await readdir(destino, { withFileTypes: true });
  if (itens.length === 1 && itens[0].isDirectory()) {
    const tmp = destino + ".tmp";
    await rm(tmp, { recursive: true, force: true });
    await rename(path.join(destino, itens[0].name), tmp);
    await rm(destino, { recursive: true, force: true });
    await rename(tmp, destino);
  }
  return { mb: Math.round(buf.length / 1e5) / 10, sha256: createHash("sha256").update(buf).digest("hex") };
}

// avisos que o pacote traz no próprio manifesto (vão como achados para os revisores)
export async function achadosDoManifesto(dir, d) {
  const achados = [];
  if (d.scripts_instalacao?.length)
    achados.push({ nivel: "bloqueio", regra: "instalacao-automatica", arquivo: "package.json", detalhe: "scripts que rodam ao instalar: " + d.scripts_instalacao.join(", ") });
  if (d.tipo === "npm") {
    const pj = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8").catch(() => "{}"));
    if (pj.name && pj.name !== d.pacote) achados.push({ nivel: "bloqueio", regra: "pacote-trocado", arquivo: "package.json", detalhe: `o arquivo diz ser "${pj.name}", não "${d.pacote}"` });
    if (pj.version && pj.version !== d.versao) achados.push({ nivel: "bloqueio", regra: "pacote-trocado", arquivo: "package.json", detalhe: `versão ${pj.version} no arquivo, ${d.versao} no registro` });
  }
  // sem repositório declarado: ninguém consegue conferir de onde veio o código
  if (d.procedencia === "sem repositório declarado")
    achados.push({ nivel: "revisar", regra: "procedencia", arquivo: "", detalhe: "o pacote não declara de qual repositório veio; confira se o autor é quem diz ser" });
  if (d.repositorio && /github\.com\/([^/]+)\/([^/#?]+)/.test(d.repositorio) && d.tipo === "npm") {
    const [, dono, repo] = /github\.com\/([^/]+)\/([^/#?]+)/.exec(d.repositorio);
    d.repo_declarado = `${dono}/${repo.replace(/\.git$/, "")}`;
  }
  return achados;
}
