# Wiki App

Base de conocimiento personal potenciada por IA. Agrega materiales, la IA los compila en articulos wiki estructurados. Cuanto mas le alimentas, mas inteligente se vuelve.

Inspirado por [Andrej Karpathy](https://x.com/karpathy): deja que los LLMs escriban y mantengan una wiki, tu lees y haces preguntas. Una wiki es un activo de conocimiento que se acumula.

**[中文](README.zh.md) | [English](../README.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | Espanol | [Portugues](README.pt.md) | [Deutsch](README.de.md)**

## Capturas de pantalla

| Panel principal | Grafo de conocimiento |
|:-:|:-:|
| ![Panel principal](../docs/screenshots/dashboard.png) | ![Grafo de conocimiento](../docs/screenshots/graph.png) |

| Lectura de articulos | Explorar articulos |
|:-:|:-:|
| ![Articulo](../docs/screenshots/article.png) | ![Explorar](../docs/screenshots/browse.png) |

| Tareas automatizadas | Modo oscuro |
|:-:|:-:|
| ![Tareas automatizadas](../docs/screenshots/autotask.png) | ![Modo oscuro](../docs/screenshots/dark-mode.png) |

## Que problemas resuelve?

**La informacion esta dispersa, se lee y se olvida.** Notas en una app, marcadores en otra, PDFs en el escritorio. Wiki App los convierte a todos en articulos buscables e interconectados -- automaticamente.

**Quieres hacer preguntas basadas en tu propio conocimiento, no en IA generica.** El chat integrado usa RAG (generacion aumentada por recuperacion) para responder desde tu wiki. Cada respuesta esta fundamentada en los articulos que has acumulado.

**Quieres que la IA monitoree temas que te importan, diariamente.** Configura tareas automatizadas con feeds RSS, paginas web y APIs como fuentes. La IA busca, filtra y compila nuevos articulos segun un horario -- tu asistente de investigacion personal.

## Caracteristicas

- **Ingesta de cualquier formato** -- Pega texto, arrastra archivos (PDF, imagenes, audio, video, ZIP) o ingresa URLs. La IA los compila en articulos estructurados con etiquetas, resumenes y referencias cruzadas.
- **Chatea con tu conocimiento** -- Preguntas y respuestas con RAG que recupera contexto de tu wiki. Busqueda hibrida: palabras clave BM25 + embeddings vectoriales (fusion RRF).
- **Grafo de conocimiento** -- Visualizacion dirigida por fuerzas de conceptos y articulos. Observa como se conecta tu conocimiento.
- **Q&A por articulo** -- Panel flotante en cada articulo para preguntas en contexto. Sesiones de conversacion por articulo con respuestas en streaming.
- **Tareas automatizadas** -- Asistente de investigacion con IA que monitorea fuentes RSS/web/API segun un horario. Filtrado de relevancia por LLM, deduplicacion y briefings diarios.
- **Edicion rica** -- Editor contenteditable estilo Notion con barra de herramientas flotante, auto-guardado, gestion de etiquetas y tabla de contenidos.
- **Multi-LLM** -- Bailian (Alibaba), OpenRouter, Anthropic, OpenAI, DeepSeek o proveedores personalizados.
- **Modo oscuro** -- Tema oscuro completo con tokens cuidadosamente ajustados.
- **Sin framework** -- Frontend en Vanilla JS, sin paso de build. Edita y recarga.

## Inicio rapido

```bash
git clone https://github.com/gongty/wiki-app.git
cd wiki-app
npm install
WIKI_API_KEY=your-api-key node server.js
# Abre http://localhost:3456
```

Puerto por defecto: 3456. Configura tu proveedor de LLM en Ajustes despues del primer inicio.

## Configuracion

### Variables de entorno

| Variable | Requerida | Descripcion |
|----------|-----------|-------------|
| `WIKI_API_KEY` | Si | API key de tu proveedor de LLM |
| `WIKI_ADMIN_TOKEN` | Produccion | Token de autenticacion (16+ caracteres) para proteger endpoints de escritura |
| `PORT` | No | Puerto del servidor (por defecto: 3456) |

### Proveedores de LLM

Configura en Ajustes despues del inicio:

| Proveedor | Notas |
|-----------|-------|
| Bailian (Alibaba Cloud) | Por defecto. API de DashScope |
| OpenRouter | Agregador multi-modelo |
| Anthropic | Modelos Claude |
| OpenAI | Modelos GPT |
| DeepSeek | LLM chino |
| Custom | Cualquier endpoint compatible con OpenAI |

## Stack tecnologico

| Capa | Eleccion | Por que |
|------|----------|---------|
| Backend | Node.js stdlib | Servidor en un solo archivo, cero dependencias de backend |
| Frontend | Vanilla JS + ES Modules | Sin framework, sin bundler, sin paso de build |
| Estilos | CSS Custom Properties | Los design tokens se propagan, modo oscuro incluido |
| Almacenamiento | Sistema de archivos | Markdown + JSON, sin base de datos |
| IA | Multi-proveedor | Interfaz unificada `callLLM()` |

## Estructura del proyecto

```
wiki-app/
├── server.js          # Servidor HTTP Node.js (~6700 lineas, API + archivos estaticos)
├── app/
│   ├── index.html     # Shell HTML
│   ├── css/           # Sistema de diseno ("Warm Ink": acento indigo, papel calido)
│   └── js/            # ES Modules
│       ├── app.js     # Punto de entrada
│       ├── router.js  # Enrutamiento basado en hash
│       └── pages/     # dashboard, chat, article, graph, browse, autotask
└── data/              # Creado automaticamente, ignorado por git
    ├── wiki/          # Articulos markdown compilados por tema
    ├── raw/           # Materiales fuente inmutables
    ├── chats/         # Historial de conversaciones (JSON)
    ├── autotasks/     # Configuracion de tareas, historial de ejecuciones, indice de dedup
    └── vectors/       # Indice de embeddings para busqueda semantica
```

## Contribuciones

Issues y pull requests son bienvenidos.

## Licencia

MIT
