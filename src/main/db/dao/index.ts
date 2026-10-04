/**
 * DAO 聚合出口。
 *
 * 技术方案 5.3：「每个实体一个 DAO 模块，**只导出窄接口**，不导出原始 `Database` 实例。」
 * 因此调用方（IPC handler）从本文件取具体函数，永远拿不到驱动本身。
 */
export * as providersDao from './providers.js';
export * as charactersDao from './characters.js';
export * as personasDao from './personas.js';
export * as conversationsDao from './conversations.js';
export * as messagesDao from './messages.js';
export * as summariesDao from './summaries.js';
export * as settingsDao from './settings.js';
