# garimbot-sandbox

Máquina descartável do **Garimbot** (Agência Systein): busca e auditoria de repositórios e pacotes públicos por script, no GitHub Actions, **sem nenhum segredo** e sem executar o código auditado (exceto no teste de funcionamento sob demanda, que roda só aqui).

- **Garimbot sandbox**: Actions › Run workflow (tema, termos ou link). O resultado sai no artefato `garimbot-execucao`.
- **Garimbot teste de funcionamento**: só para item já aprovado, no commit auditado.

Não adicione segredos neste repositório. Os scripts vêm da pasta `garimbot/` da agência.
