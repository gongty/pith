# Pith

URL, PDF, 스크린샷, 또는 텍스트를 넣으세요 -- AI가 읽고, 구조화하고, 개인 지식 베이스에 정리합니다. 필요할 때 검색하거나 자연어로 질문하세요.

RSS 피드와 웹 소스를 설정하면 AI가 매일 모니터링하고, 관심 있는 내용을 필터링하여 문서를 작성합니다. 잠자는 동안에도 지식 베이스가 성장합니다.

[Claude Code](https://claude.ai/code)로 몇 시간 만에 바이브 코딩으로 구축. 프레임워크 없음, 빌드 없음, 데이터베이스 없음 -- Node.js와 바닐라 JS만 사용. UI는 중국어, 영어, 일본어, 한국어 지원. [Andrej Karpathy](https://x.com/karpathy)의 아이디어에서 영감: LLM이 복리로 성장하는 위키를 유지하게 하자.

**[中文](README.zh.md) | [English](../README.md) | [日本語](README.ja.md) | 한국어 | [Espanol](README.es.md) | [Portugues](README.pt.md) | [Deutsch](README.de.md)**

## 스크린샷

| 대시보드 | 지식 그래프 |
|:-:|:-:|
| ![대시보드](../docs/screenshots/dashboard.png) | ![지식 그래프](../docs/screenshots/graph.png) |

| 문서 읽기 | 문서 탐색 |
|:-:|:-:|
| ![문서](../docs/screenshots/article.png) | ![탐색](../docs/screenshots/browse.png) |

| 자동화 작업 | 다크 모드 |
|:-:|:-:|
| ![자동화 작업](../docs/screenshots/autotask.png) | ![다크 모드](../docs/screenshots/dark-mode.png) |

## 다운로드

**[macOS (Apple Silicon) DMG](https://github.com/gongty/pith/releases/latest)**

서명되지 않은 빌드 -- 첫 실행 시: 우클릭 > 열기, 또는 터미널에서 `xattr -cr /Applications/Pith.app` 실행.

## 어떤 문제를 해결하나요?

**정보가 흩어져 있고, 읽으면 곧 잊어버립니다.** 노트는 한 앱에, 북마크는 다른 앱에, PDF는 바탕화면에. Pith는 이 모든 것을 검색 가능하고 서로 연결된 문서로 자동 변환합니다.

**범용 AI가 아닌, 내 지식을 기반으로 질문하고 싶습니다.** 내장 채팅은 RAG(검색 증강 생성)를 사용하여 당신의 위키에서 답변합니다. 모든 답변은 직접 축적한 문서에 기반합니다.

**관심 있는 주제를 AI가 매일 모니터링해주길 원합니다.** RSS 피드, 웹 페이지, API를 소스로 자동화 작업을 설정하세요. AI가 정해진 일정에 따라 정보를 수집, 필터링하고 새 문서로 편집합니다 -- 당신만의 개인 리서치 어시스턴트입니다.

## 기능

- **무엇이든 투입** -- 텍스트 붙여넣기, 파일 드롭(PDF, 이미지, 오디오, 비디오, ZIP), URL 입력. AI가 태그, 요약, 교차 참조를 포함한 체계적인 문서로 편집합니다.
- **내 지식과 대화** -- 위키에서 컨텍스트를 검색하는 RAG 기반 Q&A. 하이브리드 검색: BM25 키워드 + 벡터 임베딩(RRF 융합).
- **지식 그래프** -- 개념과 문서의 Force-directed 시각화. 지식이 어떻게 연결되는지 한눈에 파악할 수 있습니다.
- **문서 Q&A** -- 각 문서에서 맥락에 맞는 질문을 위한 플로팅 패널. 문서별 독립 대화 세션과 스트리밍 응답을 지원합니다.
- **자동화 작업** -- RSS/웹/API 소스를 일정에 따라 모니터링하는 AI 리서치 어시스턴트. LLM 관련성 게이팅, 중복 제거, 일일 브리핑을 제공합니다.
- **리치 편집** -- 플로팅 툴바, 자동 저장, 태그 관리, 목차를 갖춘 Notion 스타일 contenteditable 에디터.
- **Multi-LLM** -- Bailian(Alibaba), OpenRouter, Anthropic, OpenAI, DeepSeek 또는 커스텀 provider를 지원합니다.
- **다크 모드** -- 세심하게 조율된 토큰의 완전한 다크 테마.
- **제로 프레임워크** -- Vanilla JS 프론트엔드, 빌드 과정 없음. 수정하고 새로고침하면 끝.

## 빠른 시작

```bash
git clone https://github.com/gongty/pith.git
cd pith
npm install
WIKI_API_KEY=your-api-key node server.js
# http://localhost:3456 접속
```

기본 포트: 3456. 첫 실행 후 설정에서 LLM provider를 구성하세요.

## 설정

### 환경 변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `WIKI_API_KEY` | 필수 | LLM provider용 API 키 |
| `WIKI_ADMIN_TOKEN` | 프로덕션 | 쓰기 엔드포인트 보호를 위한 인증 토큰 (16자 이상) |
| `PORT` | 선택 | 서버 포트 (기본값: 3456) |

### LLM Provider

실행 후 설정에서 구성:

| Provider | 비고 |
|----------|------|
| Bailian (Alibaba Cloud) | 기본값. DashScope API |
| OpenRouter | 멀티 모델 어그리게이터 |
| Anthropic | Claude 모델 |
| OpenAI | GPT 모델 |
| DeepSeek | 중국어 LLM |
| Custom | OpenAI 호환 엔드포인트 |

## 기술 스택

| 레이어 | 선택 | 이유 |
|--------|------|------|
| Backend | Node.js stdlib | 단일 파일 서버, 백엔드 의존성 없음 |
| Frontend | Vanilla JS + ES Modules | 프레임워크 없음, 번들러 없음, 빌드 과정 없음 |
| Styling | CSS Custom Properties | 디자인 토큰 캐스케이드, 다크 모드 내장 |
| Storage | File system | Markdown + JSON, 데이터베이스 없음 |
| AI | Multi-provider | 통합 `callLLM()` 인터페이스 |

## 프로젝트 구조

```
pith/
├── server.js          # Node.js HTTP 서버 (~6700줄, API + 정적 파일)
├── app/
│   ├── index.html     # HTML 셸
│   ├── css/           # 디자인 시스템 ("Warm Ink": 인디고 악센트, 따뜻한 페이퍼)
│   └── js/            # ES Modules
│       ├── app.js     # 엔트리 포인트
│       ├── router.js  # Hash 기반 라우팅
│       └── pages/     # dashboard, chat, article, graph, browse, autotask
└── data/              # 자동 생성, gitignored
    ├── wiki/          # 토픽별 컴파일된 Markdown 문서
    ├── raw/           # 불변 원본 자료
    ├── chats/         # 대화 기록 (JSON)
    ├── autotasks/     # 작업 설정, 실행 이력, 중복 제거 인덱스
    └── vectors/       # 시맨틱 검색을 위한 임베딩 인덱스
```

## 기여

이슈와 풀 리퀘스트를 환영합니다.

## 라이선스

MIT
