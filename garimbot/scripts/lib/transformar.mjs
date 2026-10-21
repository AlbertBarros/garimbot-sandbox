// Transformar em skill, plugin ou MCP (8.14, item 4): a partir de um item
// APROVADO, cria só o esqueleto em garimbot/gerados/ com créditos, licença e
// permissões mínimas. As instruções são escritas DO ZERO pelo master (nunca
// copiadas do original) e o resultado passa por nova auditoria antes de instalar.
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { RAIZ, lerJson, memoria, pastaDoRepo, registrar } from "./base.mjs";
import { escanear } from "./scanner.mjs";
import { gitleaks } from "./ferramentas.mjs";

export async function transformar(nome, como, { agora = new Date() } = {}) {
  if (!["skill", "plugin", "mcp"].includes(como)) throw new Error("Use --como skill, plugin ou mcp.");
  const h = (await lerJson(memoria("historico"), { repositorios: {} })).repositorios?.[nome];
  if (h?.resultado !== "APROVADO") throw new Error(`${nome} não está APROVADO; audite antes de transformar.`);
  const id = pastaDoRepo(nome).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const dir = path.join(RAIZ, "gerados", `${id}-${como}`);
  if (existsSync(dir)) throw new Error("Já existe: " + dir);
  await mkdir(dir, { recursive: true });
  const creditos = `# Créditos\n\nBaseado em ${nome} (commit auditado ${h.commit}), aprovado pelo Garimbot em ${String(h.data).slice(0, 10)}.\nLicença do original: ${h.licenca ?? "confira no repositório"} — mantenha o aviso de licença e os créditos do autor.\nAs instruções deste ${como} foram escritas do zero; nenhum texto de instrução do original foi copiado.\n`;
  const permissoes = `# Permissões mínimas\n\n- Ferramentas: só as que a tarefa exige (comece com Read, Glob, Grep).\n- Nada de Bash, rede, hooks, MCP ou acesso a .env sem justificativa escrita aqui.\n- Nunca guardar token, senha ou chave neste pacote.\n`;
  const arquivos = { "CREDITOS.md": creditos, "PERMISSOES.md": permissoes };
  if (como === "skill") arquivos["SKILL.md"] = `---\nname: ${id}\ndescription: (escreva em uma frase o que a skill faz e quando usar)\n---\n\n# ${id}\n\n(Escreva aqui, do zero, o passo a passo. Não copie o README nem o CLAUDE.md do original.)\n`;
  if (como === "plugin") Object.assign(arquivos, { ".claude-plugin/plugin.json": JSON.stringify({ name: id, version: "0.1.0", description: "(escreva)" }, null, 2) + "\n", [`skills/${id}/SKILL.md`]: `---\nname: ${id}\ndescription: (escreva)\n---\n\n(Escreva do zero.)\n` });
  if (como === "mcp") Object.assign(arquivos, { "package.json": JSON.stringify({ name: id, version: "0.1.0", type: "module", private: true, license: "UNLICENSED" }, null, 2) + "\n", "server.mjs": "// Servidor MCP escrito do zero (stdio). Ferramentas só de leitura até alguém justificar o contrário.\n" });
  for (const [rel, c] of Object.entries(arquivos)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), c);
  }
  await registrar({ acao: "transformar", nome, como, pasta: path.relative(RAIZ, dir) }, agora);
  return {
    pasta: dir,
    proximo: `Peça ao Einstein para escrever, do zero, as instruções em ${path.relative(path.dirname(RAIZ), dir)} a partir do que o código aprovado faz; depois rode: node garimbot/scripts/garimbot.mjs auditar-pasta ${path.relative(path.dirname(RAIZ), dir)}`,
  };
}

// nova auditoria do que foi gerado (só script): zero bloqueio para poder instalar
export async function auditarPasta(dir) {
  const s = await escanear(dir);
  const g = await gitleaks(dir).catch((e) => ({ ok: false, erro: e.message }));
  const bloqueios = s.achados.filter((a) => a.nivel === "bloqueio");
  const revisar = s.achados.filter((a) => a.nivel === "revisar");
  return {
    pasta: dir,
    arquivos: (await readdir(dir, { recursive: true })).length,
    bloqueios,
    revisar,
    segredos: g.ok ? g.achados : null,
    resultado: bloqueios.length || (g.ok && g.achados.length) ? "REPROVADO" : !g.ok ? "INCOMPLETO (sem gitleaks)" : revisar.length ? "REVISAR" : "OK",
  };
}
