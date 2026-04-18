# Wiki App

Jogue uma URL, um PDF, um screenshot ou simplesmente cole texto -- a IA le, estrutura e arquiva no seu wiki pessoal. Na proxima vez que precisar, pesquise ou pergunte em linguagem natural.

Configure feeds RSS e fontes web, a IA monitora diariamente, filtra o que importa para voce e escreve os artigos. Sua base de conhecimento cresce enquanto voce dorme.

Construido em poucas horas de puro vibe coding com [Claude Code](https://claude.ai/code). Zero framework, zero build, zero banco de dados -- apenas Node.js e JS vanilla. Interface em chines, ingles, japones e coreano. Inspirado na ideia de [Andrej Karpathy](https://x.com/karpathy): deixar LLMs manterem um wiki que se acumula ao longo do tempo.

**[中文](README.zh.md) | [English](../README.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Espanol](README.es.md) | Portugues | [Deutsch](README.de.md)**

## Capturas de Tela

| Painel Principal | Grafo de Conhecimento |
|:-:|:-:|
| ![Painel Principal](../docs/screenshots/dashboard.png) | ![Grafo de Conhecimento](../docs/screenshots/graph.png) |

| Leitura de Artigos | Navegar Artigos |
|:-:|:-:|
| ![Artigo](../docs/screenshots/article.png) | ![Navegar](../docs/screenshots/browse.png) |

| Tarefas Automatizadas | Modo Escuro |
|:-:|:-:|
| ![Tarefas Automatizadas](../docs/screenshots/autotask.png) | ![Modo Escuro](../docs/screenshots/dark-mode.png) |

## Que problemas resolve?

**Informacao espalhada, lida e esquecida.** Notas em um app, favoritos em outro, PDFs na area de trabalho. O Wiki App transforma tudo em artigos pesquisaveis e interconectados -- automaticamente.

**Voce quer fazer perguntas com base no seu proprio conhecimento, nao em IA generica.** O chat integrado usa RAG (geracao aumentada por recuperacao) para responder a partir do seu wiki. Cada resposta e fundamentada em artigos que voce acumulou.

**Voce quer que a IA monitore topicos do seu interesse, diariamente.** Configure tarefas automatizadas com feeds RSS, paginas web e APIs como fontes. A IA busca, filtra e compila novos artigos em um cronograma -- seu assistente de pesquisa pessoal.

## Funcionalidades

- **Ingira qualquer coisa** -- Cole texto, solte arquivos (PDF, imagens, audio, video, ZIP) ou insira URLs. A IA compila em artigos estruturados com tags, resumos e referencias cruzadas.
- **Converse com seu conhecimento** -- Perguntas e respostas com RAG que recupera contexto do seu wiki. Busca hibrida: palavras-chave BM25 + embeddings vetoriais (fusao RRF).
- **Grafo de conhecimento** -- Visualizacao dirigida por forcas de conceitos e artigos. Veja como seu conhecimento se conecta.
- **Perguntas sobre artigos** -- Painel flutuante em cada artigo para perguntas contextuais. Sessoes de conversa por artigo com respostas em streaming.
- **Tarefas automatizadas** -- Assistente de pesquisa com IA que monitora fontes RSS/web/API em um cronograma. Filtragem de relevancia por LLM, deduplicacao e briefings diarios.
- **Edicao rica** -- Editor contenteditable estilo Notion com barra de ferramentas flutuante, salvamento automatico, gerenciamento de tags e indice.
- **Multi-LLM** -- Bailian (Alibaba), OpenRouter, Anthropic, OpenAI, DeepSeek ou provedores customizados.
- **Modo escuro** -- Tema escuro completo com tokens cuidadosamente ajustados.
- **Zero framework** -- Frontend em Vanilla JS, sem etapa de build. Edite e atualize.

## Inicio Rapido

```bash
git clone https://github.com/gongty/wiki-app.git
cd wiki-app
npm install
WIKI_API_KEY=your-api-key node server.js
# Abra http://localhost:3456
```

Porta padrao: 3456. Configure seu provedor LLM em Configuracoes apos a primeira execucao.

## Configuracao

### Variaveis de Ambiente

| Variavel | Obrigatoria | Descricao |
|----------|-------------|-----------|
| `WIKI_API_KEY` | Sim | Chave de API do seu provedor LLM |
| `WIKI_ADMIN_TOKEN` | Producao | Token de autenticacao (16+ caracteres) para proteger endpoints de escrita |
| `PORT` | Nao | Porta do servidor (padrao: 3456) |

### Provedores LLM

Configure em Configuracoes apos a primeira execucao:

| Provedor | Observacoes |
|----------|-------------|
| Bailian (Alibaba Cloud) | Padrao. API DashScope |
| OpenRouter | Agregador multi-modelo |
| Anthropic | Modelos Claude |
| OpenAI | Modelos GPT |
| DeepSeek | LLM chines |
| Custom | Qualquer endpoint compativel com OpenAI |

## Stack Tecnologica

| Camada | Escolha | Motivo |
|--------|---------|--------|
| Backend | Node.js stdlib | Servidor em arquivo unico, zero dependencias no backend |
| Frontend | Vanilla JS + ES Modules | Sem framework, sem bundler, sem etapa de build |
| Estilizacao | CSS Custom Properties | Design tokens em cascata, modo escuro integrado |
| Armazenamento | Sistema de arquivos | Markdown + JSON, sem banco de dados |
| IA | Multi-provedor | Interface unificada `callLLM()` |

## Estrutura do Projeto

```
wiki-app/
├── server.js          # Servidor HTTP Node.js (~6700 linhas, API + arquivos estaticos)
├── app/
│   ├── index.html     # Shell HTML
│   ├── css/           # Sistema de design ("Warm Ink": destaque indigo, papel quente)
│   └── js/            # ES Modules
│       ├── app.js     # Ponto de entrada
│       ├── router.js  # Roteamento baseado em hash
│       └── pages/     # dashboard, chat, article, graph, browse, autotask
└── data/              # Criado automaticamente, gitignored
    ├── wiki/          # Artigos markdown compilados por topico
    ├── raw/           # Materiais fonte imutaveis
    ├── chats/         # Historico de conversas (JSON)
    ├── autotasks/     # Configuracoes de tarefas, historico de execucoes, indice de dedup
    └── vectors/       # Indice de embeddings para busca semantica
```

## Contribuicoes

Issues e pull requests sao bem-vindos.

## Licenca

MIT
