# Wiki App

Wirf eine URL, ein PDF, einen Screenshot oder einfach Text rein -- die KI liest, strukturiert und archiviert es in deinem persoenlichen Wiki. Wenn du es brauchst, suche oder frag einfach in natuerlicher Sprache.

Richte RSS-Feeds und Webquellen ein, die KI ueberwacht sie taeglich, filtert was dich interessiert und schreibt die Artikel. Deine Wissensdatenbank waechst, waehrend du schlaefst.

In wenigen Stunden reines Vibe Coding mit [Claude Code](https://claude.ai/code) gebaut. Kein Framework, kein Build, keine Datenbank -- nur Node.js und Vanilla JS. Oberflaeche auf Chinesisch, Englisch, Japanisch und Koreanisch. Inspiriert von [Andrej Karpathy](https://x.com/karpathy): LLMs ein Wiki pflegen lassen, das sich ueber die Zeit aufbaut.

**[中文](README.zh.md) | [English](../README.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Espanol](README.es.md) | [Portugues](README.pt.md) | Deutsch**

## Screenshots

| Dashboard | Wissensgraph |
|:-:|:-:|
| ![Dashboard](../docs/screenshots/dashboard.png) | ![Wissensgraph](../docs/screenshots/graph.png) |

| Artikel lesen | Artikel durchsuchen |
|:-:|:-:|
| ![Artikel](../docs/screenshots/article.png) | ![Durchsuchen](../docs/screenshots/browse.png) |

| Automatisierte Aufgaben | Dark Mode |
|:-:|:-:|
| ![Automatisierte Aufgaben](../docs/screenshots/autotask.png) | ![Dark Mode](../docs/screenshots/dark-mode.png) |

## Welche Probleme loest es?

**Informationen sind verstreut, gelesen und vergessen.** Notizen in einer App, Lesezeichen in einer anderen, PDFs auf dem Desktop. Wiki App verwandelt alles in durchsuchbare, vernetzte Artikel -- automatisch.

**Du willst Fragen auf Basis deines eigenen Wissens stellen, nicht generischer KI.** Der integrierte Chat nutzt RAG (Retrieval-Augmented Generation), um aus deinem Wiki zu antworten. Jede Antwort basiert auf Artikeln, die du gesammelt hast.

**Du willst, dass KI taeglich Themen ueberwacht, die dich interessieren.** Richte automatisierte Aufgaben mit RSS-Feeds, Webseiten und APIs als Quellen ein. Die KI ruft ab, filtert und kompiliert neue Artikel nach Zeitplan -- dein persoenlicher Forschungsassistent.

## Features

- **Alles einspeisen** -- Text einfuegen, Dateien ablegen (PDF, Bilder, Audio, Video, ZIP) oder URLs eingeben. Die KI kompiliert sie zu strukturierten Artikeln mit Tags, Zusammenfassungen und Querverweisen.
- **Mit deinem Wissen chatten** -- RAG-gestuetztes Q&A, das Kontext aus deinem Wiki abruft. Hybride Suche: BM25-Schlagwoerter + Vektor-Embeddings (RRF-Fusion).
- **Wissensgraph** -- Kraftgerichtete Visualisierung von Konzepten und Artikeln. Sieh, wie dein Wissen zusammenhaengt.
- **Artikel-Q&A** -- Schwebendes Panel auf jedem Artikel fuer kontextbezogene Fragen. Artikelbezogene Gespraeche mit Streaming-Antworten.
- **Automatisierte Aufgaben** -- KI-Forschungsassistent, der RSS/Web/API-Quellen planmaessig ueberwacht. LLM-Relevanzfilterung, Deduplizierung und taegliche Briefings.
- **Umfangreiche Bearbeitung** -- Notion-aehnlicher Contenteditable-Editor mit schwebender Werkzeugleiste, Auto-Speicherung, Tag-Verwaltung und Inhaltsverzeichnis.
- **Multi-LLM** -- Bailian (Alibaba), OpenRouter, Anthropic, OpenAI, DeepSeek oder benutzerdefinierte Provider.
- **Dark Mode** -- Vollstaendiges dunkles Theme mit sorgfaeltig abgestimmten Tokens.
- **Kein Framework** -- Vanilla-JS-Frontend, kein Build-Schritt. Bearbeiten und aktualisieren.

## Schnellstart

```bash
git clone https://github.com/gongty/wiki-app.git
cd wiki-app
npm install
WIKI_API_KEY=dein-api-key node server.js
# Oeffne http://localhost:3456
```

Standard-Port: 3456. Konfiguriere deinen LLM-Provider in den Einstellungen nach dem ersten Start.

## Konfiguration

### Umgebungsvariablen

| Variable | Erforderlich | Beschreibung |
|----------|--------------|--------------|
| `WIKI_API_KEY` | Ja | API-Schluessel fuer deinen LLM-Provider |
| `WIKI_ADMIN_TOKEN` | Produktion | Auth-Token (mind. 16 Zeichen) zum Schutz von Schreibendpunkten |
| `PORT` | Nein | Server-Port (Standard: 3456) |

### LLM-Provider

Nach dem Start in den Einstellungen konfigurieren:

| Provider | Hinweise |
|----------|----------|
| Bailian (Alibaba Cloud) | Standard. DashScope API |
| OpenRouter | Multi-Model-Aggregator |
| Anthropic | Claude-Modelle |
| OpenAI | GPT-Modelle |
| DeepSeek | Chinesisches LLM |
| Custom | Jeder OpenAI-kompatible Endpunkt |

## Tech Stack

| Schicht | Wahl | Warum |
|---------|------|-------|
| Backend | Node.js stdlib | Einzeldatei-Server, keine Backend-Abhaengigkeiten |
| Frontend | Vanilla JS + ES Modules | Kein Framework, kein Bundler, kein Build-Schritt |
| Styling | CSS Custom Properties | Design-Tokens kaskadieren, Dark Mode integriert |
| Speicher | Dateisystem | Markdown + JSON, keine Datenbank |
| KI | Multi-Provider | Einheitliche `callLLM()`-Schnittstelle |

## Projektstruktur

```
wiki-app/
├── server.js          # Node.js HTTP-Server (~6700 Zeilen, API + statische Dateien)
├── app/
│   ├── index.html     # HTML-Grundgeruest
│   ├── css/           # Design-System ("Warm Ink": Indigo-Akzent, warmes Papier)
│   └── js/            # ES Modules
│       ├── app.js     # Einstiegspunkt
│       ├── router.js  # Hash-basiertes Routing
│       └── pages/     # dashboard, chat, article, graph, browse, autotask
└── data/              # Automatisch erstellt, gitignored
    ├── wiki/          # Kompilierte Markdown-Artikel nach Thema
    ├── raw/           # Unveraenderliche Quellmaterialien
    ├── chats/         # Gespraechsverlauf (JSON)
    ├── autotasks/     # Aufgabenkonfigurationen, Ausfuehrungsverlauf, Dedup-Index
    └── vectors/       # Embedding-Index fuer semantische Suche
```

## Mitwirken

Issues und Pull Requests sind willkommen.

## Lizenz

MIT
