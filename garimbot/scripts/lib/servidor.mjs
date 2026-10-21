// Serviço local da extensão do navegador (8.14, item 13). Só em 127.0.0.1,
// só responde à extensão (cabeçalho X-Garimbot + origem de extensão), sem
// token nenhum. Leitura do histórico; a única escrita é colocar um pedido na
// fila (auditar ou watchlist), que a próxima execução processa.
import http from "node:http";
import { lerJson, gravarJson, memoria, registrar } from "./base.mjs";
import { imitacao } from "./busca.mjs";
import { promptIntegracao } from "./relatorio.mjs";

export const PORTA = 47613;
const ORIGEM_OK = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]{8,64}$/i;

// "github:dono/repo", "npm:pacote", "pypi:pacote" → como está no histórico
export async function veredito(item) {
  const hist = await lerJson(memoria("historico"), { repositorios: {} });
  const bloq = await lerJson(memoria("bloqueados"), { repositorios: {} });
  let chaves = [];
  let parecido = null;
  const m = /^github:([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})$/.exec(item);
  if (m) {
    chaves = [m[1]];
    parecido = imitacao(m[1]);
  } else if (/^(npm|pypi):[@A-Za-z0-9/._-]{1,214}$/.test(item)) {
    chaves = Object.keys(hist.repositorios).filter((k) => k === item || k.startsWith(item + "@") || k.startsWith(item + "=="));
  } else if (/^hf:[A-Za-z0-9._/-]{1,200}$/.test(item)) return { item, status: "nao-auditado", observacao: "modelos do Hugging Face ainda não são auditados pelo Garimbot" };
  else return { status: "invalido" };
  const k = chaves.find((x) => hist.repositorios[x]?.resultado === "APROVADO") ?? chaves[0];
  const h = k ? hist.repositorios[k] : null;
  if (!h) return { item, status: "nao-auditado", imitacao: parecido };
  if (h.resultado === "APROVADO")
    return { item: k, status: "aprovado", commit: h.commit, data: h.data, nota: h.nota ?? null, imitacao: parecido, prompt: promptIntegracao({ nome: k, commit: h.commit, tipo: h.tipo, pacote: k.replace(/^(npm|pypi):/, "").replace(/(@|==)[^@]*$/, ""), versao: h.commit }) };
  return { item: k, status: "reprovado", data: h.data, motivo: (bloq.repositorios?.[k]?.motivos ?? [])[0] ?? "reprovado na auditoria", imitacao: parecido };
}

export async function enfileirar({ item, acao }) {
  if (!["auditar", "watchlist"].includes(acao)) throw new Error("ação inválida");
  if (!/^(github:[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}|npm:[@A-Za-z0-9/._-]{1,214}|pypi:[A-Za-z0-9._-]{1,100})$/.test(item)) throw new Error("item inválido");
  const fila = await lerJson(memoria("fila"), { pedidos: [] });
  if (!fila.pedidos.some((p) => p.item === item && p.acao === acao)) fila.pedidos = [...fila.pedidos, { item, acao, em: new Date().toISOString() }].slice(-200);
  await gravarJson(memoria("fila"), fila);
  await registrar({ acao: "fila", item, pedido: acao });
  return { ok: true, na_fila: fila.pedidos.length };
}

export function criarServidor() {
  return http.createServer(async (req, res) => {
    const responder = (codigo, dados) => {
      res.writeHead(codigo, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(dados));
    };
    try {
      // páginas comuns não passam: só a extensão manda este cabeçalho com origem de extensão
      if (req.headers["x-garimbot"] !== "1" || !ORIGEM_OK.test(String(req.headers.origin ?? ""))) return responder(403, { erro: "só a extensão do Garimbot" });
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/veredito") return responder(200, await veredito(String(url.searchParams.get("item") ?? "").slice(0, 260)));
      if (req.method === "POST" && url.pathname === "/fila") {
        let corpo = "";
        for await (const c of req) {
          corpo += c;
          if (corpo.length > 2000) return responder(413, { erro: "pedido grande demais" });
        }
        const d = JSON.parse(corpo || "{}");
        return responder(200, await enfileirar({ item: String(d.item ?? ""), acao: String(d.acao ?? "") }));
      }
      responder(404, { erro: "não encontrado" });
    } catch (e) {
      responder(400, { erro: String(e.message).slice(0, 120) });
    }
  });
}
