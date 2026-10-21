// Botões da seção 7, sempre depois do seu "sim":
//  - Clonar: só na QUARENTENA (fora de qualquer repositório seu), no commit
//    exato auditado, com os arquivos de instrução para IA neutralizados;
//  - Clonar e usar: além disso, cria o branch integra/<nome> no projeto e um
//    ponto de restauração; o plano de integração é feito antes de mexer.
// Nunca instala, compila nem roda nada do repositório.
import { mkdir, readdir, rename, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { rodar } from "./ferramentas.mjs";
import { clonar } from "./auditoria.mjs";
import { lerJson, gravarJson, memoria, registrar, pastaDoRepo, nomeRepo } from "./base.mjs";
import { ARQUIVOS_IA } from "./scanner.mjs";

// confere se o repositório foi APROVADO naquele commit e se o commit atual ainda é o mesmo
export async function conferirAprovacao(nome, commit, { remoto = true } = {}) {
  const hist = await lerJson(memoria("historico"), { repositorios: {} });
  const h = hist.repositorios?.[nome];
  if (!h || h.resultado !== "APROVADO" || h.commit !== commit)
    throw new Error(`${nome} não está APROVADO no commit ${String(commit).slice(0, 10)}. Rode a auditoria antes.`);
  if (remoto) {
    const r = await rodar("git", ["ls-remote", `https://github.com/${nome}.git`, "HEAD"], { timeoutMs: 60e3 });
    const atual = r.out.split(/\s/)[0];
    if (r.codigo !== 0 || !atual) throw new Error("não consegui conferir o commit atual no GitHub; tente de novo.");
    if (atual !== commit)
      return { mudou: true, atual, aviso: `O repositório mudou desde a auditoria (agora ${atual.slice(0, 10)}). Vou clonar o commit AUDITADO; para usar o novo, audite de novo.` };
  }
  return { mudou: false };
}

// tira do caminho os arquivos de instrução para IA de terceiros (CLAUDE.md, .claude/, .mcp.json…)
export async function neutralizar(dir) {
  const movidos = [];
  const destino = path.join(dir, "_garimbot-ia-neutralizado");
  async function andar(rel = "") {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (r === ".git" || r === "_garimbot-ia-neutralizado") continue;
      const ehIa = ARQUIVOS_IA.some((re) => re.test(r + (e.isDirectory() ? "/" : "")));
      if (ehIa) {
        const alvo = path.join(destino, r.replace(/\//g, "__") + ".neutralizado");
        await mkdir(destino, { recursive: true });
        await rename(path.join(dir, r), alvo);
        movidos.push(r);
      } else if (e.isDirectory()) await andar(r);
    }
  }
  await andar();
  if (movidos.length)
    await writeFile(
      path.join(destino, "LEIA.txt"),
      "O Garimbot tirou estes arquivos de instrução para IA do repositório de terceiros, para nenhum agente seu ler ordens externas.\nSó volte com algum deles depois de revisar e aprovar.\n\n" + movidos.join("\n") + "\n",
    );
  // hooks do git nunca rodam (o clone já usa hooksPath vazio); tira os exemplos
  await rm(path.join(dir, ".git", "hooks"), { recursive: true, force: true });
  return movidos;
}

export async function adicionarWatchlist(item) {
  const w = await lerJson(memoria("watchlist"), { repositorios: [] });
  w.repositorios = [...w.repositorios.filter((x) => x.nome !== item.nome), item];
  await gravarJson(memoria("watchlist"), w);
}

export async function clonarQuarentena(nomeBruto, commit, { quarentena, remoto = true } = {}) {
  const nome = nomeRepo(nomeBruto);
  if (!/^[0-9a-f]{40}$/.test(String(commit))) throw new Error("Commit inválido.");
  const c = await conferirAprovacao(nome, commit, { remoto });
  // .garimbot/quarentena/<dono>__<repo> (formato liberado pelo Guard)
  const dir = path.join(quarentena, pastaDoRepo(nome));
  await stat(dir).then(
    () => {
      throw new Error("Já existe na quarentena: " + dir + " (apague a pasta para clonar de novo).");
    },
    () => {},
  );
  await clonar(nome, dir, { commit, maxMb: 2000 });
  const neutralizados = await neutralizar(dir);
  await adicionarWatchlist({ nome, commit, pasta: dir, clonadoEm: new Date().toISOString(), neutralizados });
  await registrar({ acao: "clonar", nome, commit, pasta: dir, neutralizados });
  return { pasta: dir, neutralizados, ...c };
}

// "Clonar e usar no projeto": quarentena + branch integra/<nome> e ponto de restauração no projeto
export async function prepararUso(nomeBruto, commit, { quarentena, projeto, remoto = true } = {}) {
  const nome = nomeRepo(nomeBruto);
  const q = await clonarQuarentena(nome, commit, { quarentena, remoto });
  const st = await rodar("git", ["-C", projeto, "status", "--porcelain"]);
  if (st.codigo !== 0) throw new Error("A pasta do projeto não é um repositório git: " + projeto);
  if (st.out.trim()) throw new Error("O projeto tem alterações não salvas. Salve (commit) antes de integrar.");
  const ramo = "integra/" + nome.split("/")[1].toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const tag = "garimbot/antes-" + nome.split("/")[1].toLowerCase().replace(/[^a-z0-9._-]/g, "-") + "-" + Date.now().toString(36);
  const t = await rodar("git", ["-C", projeto, "tag", tag]);
  if (t.codigo !== 0) throw new Error("não consegui criar o ponto de restauração: " + t.err.slice(-200));
  const b = await rodar("git", ["-C", projeto, "switch", "-c", ramo]);
  if (b.codigo !== 0) throw new Error("não consegui criar o branch " + ramo + ": " + b.err.slice(-200));
  await adicionarWatchlist({ nome, commit, pasta: q.pasta, clonadoEm: new Date().toISOString(), neutralizados: q.neutralizados, projeto, ramo, ponto_de_restauracao: tag });
  await registrar({ acao: "usar", nome, commit, projeto, ramo, ponto_de_restauracao: tag });
  return { ...q, ramo, ponto_de_restauracao: tag };
}
