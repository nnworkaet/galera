import type { Lang } from "./config";

type Strings = typeof RU;

const RU = {
  // /cancel
  cancelled: "Отменено.",

  // /agents
  agents_none: "Агентов нет.",
  agents_header: "Агенты:",
  agent_role_orchestrator: "Оркестратор",

  // /kill_agent
  agent_removed: (id: string) => `Агент ${id} удалён.`,
  agent_not_found: (id: string) => `Агент ${id} не найден.`,

  // /secret_*
  secret_saved: (key: string) => `Секрет ${key} сохранён.`,
  secrets_list: (keys: string) => `Секреты: ${keys}`,
  secrets_empty: "Секреты не сохранены.",
  secret_deleted: (key: string) => `Секрет ${key} удалён.`,
  secret_not_found: "Секрет не найден.",
  secrets_reloaded: "Секреты обновлены в shared memory.",

  // /setup_general
  setup_need_topic: "Запусти /setup_general внутри форум-топика.",
  setup_done: (topicId: number, chatId: number) =>
    `✅ Топик ${topicId} в чате ${chatId} настроен как General.\nПерезапусти бота для применения.`,

  // /compact
  compact_start: "⏳ Сжимаю контексты агентов...",
  compact_prompt: "Запиши ключевые факты этой сессии в topic-memory.md, затем сообщи [DONE].",
  compact_done: (done: number, total: number) => `✅ Готово: ${done}/${total} агентов сжато.`,

  // /recall
  recall_none: (q: string) => `🔍 Ничего не найдено по запросу: «${q}»`,
  recall_found: (n: number) => `🔍 Найдено ${n} совпадений, показываю топ-3:`,

  // /ltm_list
  ltm_empty: "📭 Долгосрочная память пуста.",
  ltm_index_caption: "📚 Индекс долгосрочной памяти (LTM)",

  // /ltm_show
  ltm_not_found: (f: string) => `❌ Файл «${f}» не найден в LTM.`,
  ltm_file_caption: (f: string) => `📄 LTM / ${f}`,

  // /memory
  memory_main_caption: "📋 Общая память (main-memory.md)",
  memory_topic_caption: (name: string) => `🗒 ${name} — память сессии`,
  memory_ltm_caption: "📚 Долгосрочная память — индекс (LTM)",
  memory_empty: "📭 Файлы памяти не найдены.",

  // /status
  status_system: (n: number) => `Система: ${n} агент${n === 1 ? "" : n < 5 ? "а" : "ов"} запущено`,
  status_today: (msgs: number, tokens: string) => `Сегодня: ${msgs} сообщений, ${tokens}`,
  status_week: (msgs: number, tokens: string) => `Эта неделя: ${msgs} сообщений, ${tokens}`,
  status_ltm: (files: number, kb: string) => `LTM: ${files} файл${files === 1 ? "" : files < 5 ? "а" : "ов"}, ${kb} KB`,
  status_ltm_updated: (d: string) => `  Обновлено: ${d}`,
  status_memory_header: "Память (topic-memory.md):",
  status_tokens: (n: number) => n >= 1000 ? `~${(n / 1000).toFixed(1)}k ≈токенов` : `~${n} ≈токенов`,

  // /help
  help: [
    "📋 Команды CEO:",
    "",
    "👥 Агенты:",
    "/new_agent — добавить нового агента",
    "/agents — список агентов и статус",
    "/kill_agent <id> — остановить и удалить агента",
    "",
    "🧠 Память:",
    "/memory — все файлы памяти (MD-файлы)",
    "/recall <запрос> — поиск в долгосрочной памяти",
    "/ltm_list — индекс долгосрочной памяти",
    "/ltm_show <файл> — показать файл из LTM",
    "/compact — сжать контекст сессии агентов",
    "",
    "🔐 Секреты:",
    "/secret_set <key> <value> — сохранить секрет",
    "/secret_list — список ключей",
    "/secret_delete <key> — удалить секрет",
    "/secret_reload — обновить в shared memory",
    "",
    "📊 Система:",
    "/status — статистика использования и память",
    "/setup_general — настроить этот топик как General",
    "/cancel — отменить текущую операцию",
  ].join("\n"),
};

const EN: Strings = {
  cancelled: "Cancelled.",

  agents_none: "No agents registered.",
  agents_header: "Agents:",
  agent_role_orchestrator: "Orchestrator",

  agent_removed: (id: string) => `Agent ${id} removed.`,
  agent_not_found: (id: string) => `Agent ${id} not found.`,

  secret_saved: (key: string) => `Secret ${key} saved.`,
  secrets_list: (keys: string) => `Secrets: ${keys}`,
  secrets_empty: "No secrets stored.",
  secret_deleted: (key: string) => `Secret ${key} deleted.`,
  secret_not_found: "Secret not found.",
  secrets_reloaded: "Secrets updated in shared memory.",

  setup_need_topic: "Run /setup_general inside a forum topic.",
  setup_done: (topicId: number, chatId: number) =>
    `✅ Topic ${topicId} in chat ${chatId} configured as General.\nRestart the bot to apply.`,

  compact_start: "⏳ Compressing agent contexts...",
  compact_prompt: "Summarise key facts from this session into topic-memory.md, then reply [DONE].",
  compact_done: (done: number, total: number) => `✅ Done: ${done}/${total} agents compacted.`,

  recall_none: (q: string) => `🔍 Nothing found for: "${q}"`,
  recall_found: (n: number) => `🔍 Found ${n} result${n === 1 ? "" : "s"}, showing top 3:`,

  ltm_empty: "📭 Long-term memory is empty.",
  ltm_index_caption: "📚 Long-term memory index (LTM)",

  ltm_not_found: (f: string) => `❌ File "${f}" not found in LTM.`,
  ltm_file_caption: (f: string) => `📄 LTM / ${f}`,

  memory_main_caption: "📋 Shared memory (main-memory.md)",
  memory_topic_caption: (name: string) => `🗒 ${name} — session memory`,
  memory_ltm_caption: "📚 Long-term memory index (LTM)",
  memory_empty: "📭 No memory files found.",

  status_system: (n: number) => `System: ${n} agent${n === 1 ? "" : "s"} running`,
  status_today: (msgs: number, tokens: string) => `Today: ${msgs} messages, ${tokens}`,
  status_week: (msgs: number, tokens: string) => `This week: ${msgs} messages, ${tokens}`,
  status_ltm: (files: number, kb: string) => `LTM: ${files} file${files === 1 ? "" : "s"}, ${kb} KB`,
  status_ltm_updated: (d: string) => `  Last updated: ${d}`,
  status_memory_header: "Memory (topic-memory.md):",
  status_tokens: (n: number) => n >= 1000 ? `~${(n / 1000).toFixed(1)}k est. tokens` : `~${n} est. tokens`,

  help: [
    "📋 CEO Commands:",
    "",
    "👥 Agents:",
    "/new_agent — add a new agent",
    "/agents — list agents and status",
    "/kill_agent <id> — stop and remove an agent",
    "",
    "🧠 Memory:",
    "/memory — send all memory files as MD documents",
    "/recall <query> — search long-term memory",
    "/ltm_list — show LTM index",
    "/ltm_show <file> — send a specific LTM file",
    "/compact — compress all agent session contexts",
    "",
    "🔐 Secrets:",
    "/secret_set <key> <value> — store a secret",
    "/secret_list — list secret keys",
    "/secret_delete <key> — delete a secret",
    "/secret_reload — update in shared memory",
    "",
    "📊 System:",
    "/status — usage stats and memory sizes",
    "/setup_general — configure this topic as General",
    "/cancel — cancel current operation",
  ].join("\n"),
};

const LANGS: Record<Lang, Strings> = { ru: RU, en: EN };

export function useI18n(lang: Lang = "ru"): Strings {
  return LANGS[lang] ?? RU;
}
