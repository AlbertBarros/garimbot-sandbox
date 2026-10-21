// Busca ampla no GitHub (API REST de busca) e pré-filtro de reputação, sem
// baixar código. Token opcional e SOMENTE LEITURA (GARIMBOT_GITHUB_TOKEN, ou o
// GITHUB_TOKEN de leitura do sandbox). Texto de descrição/tópicos é dado.
const API = "https://api.github.com";
const cabecalhos = (token) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "garimbot",
  ...(token ? { Authorization: "Bearer " + token } : {}),
});
async function getJson(url, { token, fetcher = fetch } = {}) {
  const r = await fetcher(url, { headers: cabecalhos(token) });
  if (!r.ok) throw new Error(`GitHub respondeu ${r.status} em ${new URL(url).pathname}`);
  return r.json();
}
const resumo = (r) => ({
  nome: r.full_name,
  url: r.html_url,
  descricao: String(r.description ?? "").slice(0, 300),
  estrelas: r.stargazers_count ?? 0,
  forks: r.forks_count ?? 0,
  issues_abertas: r.open_issues_count ?? 0,
  linguagem: r.language ?? null,
  topicos: (r.topics ?? []).slice(0, 20),
  licenca: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
  arquivado: Boolean(r.archived),
  fork: Boolean(r.fork),
  criado: r.created_at,
  ultimo_push: r.pushed_at,
  ramo: r.default_branch,
  tamanho_kb: r.size ?? 0,
  dono: { login: r.owner?.login, tipo: r.owner?.type },
});

// até `limite` candidatos, juntando os termos (sem repetir)
// filtros por tipo (8.14, item 2): o tipo vira palavras na busca
export const TIPOS = {
  mcp: "mcp server", plugin: "claude code plugin", skill: "claude skill", agente: "ai agent", prompts: "prompts",
  template: "template", sistema: "self-hosted", biblioteca: "library", api: "sdk", componente: "react component",
  workflow: "workflow automation", extensao: "browser extension", cli: "cli", action: "github action", modelo: "model", kit: "starter kit",
};
export const LICENCAS_COMERCIAIS = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "MPL-2.0", "Zlib", "CC0-1.0"];
export function aplicarFiltros(termos, { tipo, linguagem } = {}) {
  if (tipo && !TIPOS[tipo]) throw new Error("Tipo desconhecido: " + tipo + " (use: " + Object.keys(TIPOS).join(", ") + ")");
  if (linguagem && !/^[A-Za-z0-9+#.-]{1,30}$/.test(linguagem)) throw new Error("Linguagem inválida.");
  return termos.map((t) => [t, tipo ? TIPOS[tipo] : "", linguagem ? "language:" + linguagem : ""].filter(Boolean).join(" "));
}

export async function buscar({ termos, limite = 100, token, fetcher }) {
  const vistos = new Map();
  const porTermo = Math.max(10, Math.ceil(limite / Math.max(1, termos.length)));
  for (const termo of termos) {
    if (vistos.size >= limite) break;
    const q = encodeURIComponent(`${termo} fork:false archived:false`);
    const d = await getJson(
      `${API}/search/repositories?q=${q}&sort=stars&order=desc&per_page=${Math.min(100, porTermo)}`,
      { token, fetcher },
    );
    for (const r of d.items ?? []) {
      if (vistos.size >= limite) break;
      if (!vistos.has(r.full_name)) vistos.set(r.full_name, { ...resumo(r), termo });
    }
  }
  return [...vistos.values()];
}
// fonte npm (fase 3): busca do registro por termo; os dados completos vêm depois (dadosDoPacote)
export async function buscarNpm({ termos, limite = 30, fetcher = fetch }) {
  const vistos = new Map();
  const porTermo = Math.max(5, Math.ceil(limite / Math.max(1, termos.length)));
  for (const termo of termos) {
    if (vistos.size >= limite) break;
    const r = await fetcher(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(termo)}&size=${Math.min(50, porTermo)}`, { headers: { Accept: "application/json", "User-Agent": "garimbot" } });
    if (!r.ok) throw new Error("busca do npm respondeu " + r.status);
    for (const o of (await r.json()).objects ?? []) {
      if (vistos.size >= limite) break;
      const p = o.package;
      if (p?.name && p.version && !vistos.has(p.name)) vistos.set(p.name, { pacote: p.name, versao: p.version, termo, topicos: (p.keywords ?? []).slice(0, 20), downloads: o.downloads?.weekly ?? null });
    }
  }
  return [...vistos.values()];
}

// dados de um repositório só (análise de link / porteiro); sem rede, volta null
export async function dadosDoRepo(nome, { token, fetcher } = {}) {
  const r = await getJson(`${API}/repos/${nome}`, { token, fetcher }).catch(() => null);
  return r?.full_name ? resumo(r) : null;
}
// dados do dono (idade da conta) para o pré-filtro
export async function completarDonos(candidatos, { token, fetcher, max = 40 } = {}) {
  const cache = new Map();
  for (const c of candidatos.slice(0, max)) {
    const login = c.dono.login;
    if (!cache.has(login))
      cache.set(
        login,
        await getJson(`${API}/users/${encodeURIComponent(login)}`, { token, fetcher }).catch(() => null),
      );
    const u = cache.get(login);
    c.dono.criado = u?.created_at ?? null;
    c.dono.seguidores = u?.followers ?? null;
  }
  return candidatos;
}

// ---------- pré-filtro de reputação ----------
// projetos famosos para pegar imitações de nome (typosquatting)
export const FAMOSOS = [
  "facebook/react", "vercel/next.js", "vitejs/vite", "tailwindlabs/tailwindcss",
  "firebase/firebase-js-sdk", "cloudflare/workers-sdk", "remotion-dev/remotion",
  "microsoft/vscode", "microsoft/playwright", "openai/whisper", "FFmpeg/FFmpeg",
  "n8n-io/n8n", "anthropics/claude-code", "modelcontextprotocol/servers",
  "expressjs/express", "lodash/lodash", "axios/axios", "nodejs/node",
  "pedroslopez/whatsapp-web.js", "WhiskeySockets/Baileys", "langchain-ai/langchain",
];
export function distancia(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function imitacao(nome) {
  const [dono, repo] = nome.split("/");
  for (const f of FAMOSOS) {
    const [fd, fr] = f.split("/");
    if (fd.toLowerCase() === dono.toLowerCase()) return null;
    const dr = distancia(repo, fr);
    if (repo.toLowerCase() === fr.toLowerCase() || (fr.length >= 5 && dr > 0 && dr <= 2))
      return f;
  }
  return null;
}
const dias = (iso, agora) => (iso ? (agora - Date.parse(iso)) / 864e5 : Infinity);
// devolve { aprovados, descartados: [{nome, motivo}] }
export function prefiltrar(candidatos, regras = {}, agora = Date.now()) {
  const r = {
    meses_sem_commit: 12,
    exige_licenca: true,
    conta_nova_dias: 90,
    conta_nova_estrelas: 300,
    ignorar_forks: true,
    ...regras,
  };
  // filtros do dono: só licença de uso comercial; só atualizado nos últimos meses
  if (regras.recente_meses) r.meses_sem_commit = Math.min(r.meses_sem_commit, regras.recente_meses);
  const aprovados = [],
    descartados = [];
  for (const c of candidatos) {
    const motivo = c.arquivado
      ? "arquivado"
      : r.ignorar_forks && c.fork
        ? "fork"
        : dias(c.ultimo_push, agora) > r.meses_sem_commit * 30.5
          ? `sem commits há mais de ${r.meses_sem_commit} meses`
          : r.exige_licenca && !c.licenca
            ? "sem licença"
            : r.so_comercial && !LICENCAS_COMERCIAIS.includes(c.licenca)
            ? `licença ${c.licenca} não é livre para uso comercial (filtro)`
            : imitacao(c.nome)
              ? `nome parecido com ${imitacao(c.nome)} (possível imitação)`
              : c.dono?.criado &&
                  dias(c.dono.criado, agora) < r.conta_nova_dias &&
                  c.estrelas > r.conta_nova_estrelas
                ? "conta nova com muitas estrelas"
                : null;
    if (motivo) descartados.push({ nome: c.nome, motivo });
    else aprovados.push(c);
  }
  return { aprovados, descartados };
}
