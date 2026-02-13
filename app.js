import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import client from './lib/redis.js';
import dotenv from 'dotenv';
import helmet from 'helmet';
import morgan from 'morgan';
import { readFile } from 'fs/promises';

// 加载环境变量
dotenv.config();

const app = express();
const PORT = process.env.PORT;
const NODE_ENV = process.env.NODE_ENV;
const LOG_LEVEL = process.env.LOG_LEVEL;

// 从环境变量获取配置
const ADMIN_ACCOUNT = process.env.ADMIN_ACCOUNT;
const MASTER_PASSWORD = process.env.MASTER_PASSWORD;
const REAL_MASTER_QQ = process.env.REAL_MASTER_QQ;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;

// OneBot 配置
const ONEBOT_WS_URL = process.env.ONEBOT_WS_URL;
const ONEBOT_SELF_ID = process.env.ONEBOT_SELF_ID;;
const ONEBOT_BOT_NAME = process.env.ONEBOT_BOT_NAME;;
const ONEBOT_ACCESS_TOKEN = process.env.ONEBOT_ACCESS_TOKEN;

// 验证必要环境变量
if (!ADMIN_ACCOUNT || !MASTER_PASSWORD) {
  console.error('❌ 请设置必要的环境变量: ADMIN_ACCOUNT, MASTER_PASSWORD');
  process.exit(1);
}

console.log(`🔐 认证服务配置:`);
console.log(`   - 运行模式: ${NODE_ENV}`);
console.log(`   - 服务端口: ${PORT}`);
console.log(`   - 日志级别: ${LOG_LEVEL}`);
console.log(`   - 超管账号: ${ADMIN_ACCOUNT}`);
console.log(`   - 超管密码: ${MASTER_PASSWORD ? '已设置' : '未设置'}`);
console.log(`   - 真实MasterQQ: ${REAL_MASTER_QQ}`);
console.log(`   - OneBot后端: ${ONEBOT_WS_URL}`);
console.log(`   - 机器人QQ: ${ONEBOT_SELF_ID}`);
console.log(`   - Access Token: ${ONEBOT_ACCESS_TOKEN ? '已设置' : '未设置'}`);

// 允许的域名列表
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

// 日志配置
const LOG_CONFIG = {
  maxDataLength: 64,
  maxMessageLength: 200,
  maxStringLength: 100,
  truncateSuffix: '...',
  logLevel: LOG_LEVEL
};

// 心跳和重连配置 - 关键修改：移除最大重连次数限制，调整重连策略
const HEARTBEAT_INTERVAL = 15000;
const HEARTBEAT_TIMEOUT = 30000;
const RECONNECT_BASE_DELAY = 5000;
const RECONNECT_MAX_DELAY = 60000;
const WATCHDOG_INTERVAL = 60000; // 新增：1分钟一次的连接看门狗

// 全局状态
let oneBotWs = null;
let oneBotConnected = false;
let wss = null;
const onlineUsers = new Map();
const userInfoMap = new Map();

// 管理员会话管理
let activeAdminSession = null;
const ADMIN_SESSION_PREFIX = 'admin_session:';
const ADMIN_SESSION_TTL = 24 * 60 * 60;

// 头像缓存
let avatarCache = null;
let lastAvatarLoadTime = 0;
const AVATAR_CACHE_DURATION = 5 * 60 * 1000;

// 心跳和重连状态 - 关键修改：移除重连次数限制
let heartbeatTimer = null;
let lastHeartbeatTime = 0;
let reconnectAttempts = 0;
let isReconnecting = false;
let lastHeartbeatSuccess = false;
let watchdogTimer = null; // 新增：看门狗定时器

/**
 * 压缩日志数据
 */
function compressLogData(data, maxLength = LOG_CONFIG.maxDataLength) {
  if (typeof data === 'string') {
    if (data.length > maxLength) {
      return data.substring(0, maxLength) + LOG_CONFIG.truncateSuffix + `[长度:${data.length}]`;
    }
    return data;
  }
  return data;
}

/**
 * 深度压缩对象中的长字符串
 */
function compressObjectForLog(obj, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) {
    return '[对象深度过大]';
  }
  
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'string') {
    return compressLogData(obj, LOG_CONFIG.maxStringLength);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => compressObjectForLog(item, depth + 1, maxDepth));
  }
  
  if (typeof obj === 'object') {
    const compressed = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'data' || key === 'message' || key === 'file' || key === 'image' || key === 'base64') {
        if (typeof value === 'string' && value.length > LOG_CONFIG.maxDataLength) {
          compressed[key] = compressLogData(value);
        } else if (typeof value === 'object' && value !== null) {
          if (value.file && typeof value.file === 'string') {
            compressed[key] = {
              ...value,
              file: compressLogData(value.file)
            };
          } else if (value.url && typeof value.url === 'string') {
            compressed[key] = {
              ...value,
              url: compressLogData(value.url)
            };
          } else if (value.base64 && typeof value.base64 === 'string') {
            compressed[key] = {
              ...value,
              base64: compressLogData(value.base64)
            };
          } else {
            compressed[key] = compressObjectForLog(value, depth + 1, maxDepth);
          }
        } else {
          compressed[key] = value;
        }
      } else {
        compressed[key] = compressObjectForLog(value, depth + 1, maxDepth);
      }
    }
    return compressed;
  }
  
  return obj;
}

/**
 * 压缩消息日志输出
 */
function logCompressedMessage(prefix, message, type = 'message') {
  if (LOG_CONFIG.logLevel !== 'debug') {
    return;
  }
  
  try {
    const compressed = compressObjectForLog(message);
    console.log(`${prefix}:`, JSON.stringify(compressed, null, 0));
  } catch (error) {
    console.log(`${prefix}: [日志压缩失败] ${error.message}`);
  }
}

/**
 * 记录简要消息摘要
 */
function logMessageSummary(prefix, message, direction = 'receive') {
  const summary = {
    type: message.action || message.post_type || 'unknown',
    timestamp: new Date().toISOString(),
    direction: direction
  };
  
  if (message.action) {
    summary.action = message.action;
  }
  if (message.post_type) {
    summary.post_type = message.post_type;
  }
  if (message.message_type) {
    summary.message_type = message.message_type;
  }
  if (message.user_id) {
    summary.user_id = message.user_id;
  }
  if (message.self_id) {
    summary.self_id = message.self_id;
  }
  
  if (message.message) {
    if (Array.isArray(message.message)) {
      summary.message_types = message.message.map(m => m.type).join(',');
      summary.message_count = message.message.length;
    }
  }
  
  const frequentActions = [
    '_set_model_show', 'get_login_info', 'get_guild_service_profile',
    'get_online_clients', 'get_version_info', 'get_cookies', 'get_csrf_token',
    'get_friend_list', 'get_group_list', 'get_guild_list', 'get_status',
    'get_stranger_info', 'get_group_info', 'get_group_member_info',
    'get_group_member_list', 'get_group_honor_info', 'get_group_system_msg',
    'get_essence_msg_list', 'get_group_at_all_remain', 'get_record',
    'get_image', 'can_send_image', 'can_send_record', 'get_credentials',
    'check_update', 'reload_event_filter', 'download_file', 'get_group_msg_history',
    'get_forward_msg', 'get_group_file_system_info', 'get_group_root_files',
    'get_group_files_by_folder', 'get_group_file_url', 'get_group_notice',
    'get_model_show', 'get_group_meta', 'get_guild_meta', 'get_channel_meta',
    'get_guild_member_list', 'get_guild_member_profile', 'get_guild_msg',
    'get_topic_channel_feeds', '.handle_quick_operation'
  ];
  
  if (summary.action && frequentActions.includes(summary.action)) {
    if (LOG_CONFIG.logLevel === 'debug') {
      console.log(`${prefix}:`, JSON.stringify(summary));
    }
  } else {
    console.log(`${prefix}:`, JSON.stringify(summary));
  }
}

/**
 * 日志工具函数
 */
function logInfo(message, ...args) {
  console.log(`[INFO] ${message}`, ...args);
}

function logDebug(message, ...args) {
  if (LOG_CONFIG.logLevel === 'debug') {
    console.log(`[DEBUG] ${message}`, ...args);
  }
}

function logWarn(message, ...args) {
  console.warn(`[WARN] ${message}`, ...args);
}

function logError(message, ...args) {
  console.error(`[ERROR] ${message}`, ...args);
}

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// 中间件配置
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS配置
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      logWarn(`[CORS] 拒绝来自 ${origin} 的请求`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-auth-token']
}));

// 请求日志中间件
if (NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', {
    skip: (req, res) => req.path === '/health'
  }));
}

// 预检请求处理
app.options('*', cors());

// 自定义请求日志
app.use((req, res, next) => {
  const referer = req.get('referer') || req.get('origin') || 'unknown';
  logInfo(`[${new Date().toISOString()}] ${req.method} ${req.path} ${req.ip} Referer: ${referer}`);
  next();
});

/**
 * 从JSON文件读取头像列表
 */
async function getAvatarList() {
  const now = Date.now();
  
  if (avatarCache && (now - lastAvatarLoadTime) < AVATAR_CACHE_DURATION) {
    return avatarCache;
  }
  
  try {
    const data = await readFile('./config/头像.json', 'utf8');
    avatarCache = JSON.parse(data);
    lastAvatarLoadTime = now;
    
    if (!Array.isArray(avatarCache) || avatarCache.length === 0) {
      logWarn('头像列表为空，使用默认头像');
      avatarCache = [
        {
          "url": "https://tc.ayakasuki.com/a/2025/06/08/biji6844993996f0a.jpg",
          "alt": "顾清寒"
        },
        {
          "url": "https://tc.ayakasuki.com/a/2025/06/08/biji6844993874ee9.jpg",
          "alt": "土御门胡桃"
        }
      ];
    }
    
    return avatarCache;
  } catch (error) {
    logError('读取头像文件失败，使用默认头像:', error.message);
    avatarCache = [
      {
        "url": "https://tc.ayakasuki.com/a/2025/06/08/biji6844993996f0a.jpg",
        "alt": "顾清寒"
      },
      {
        "url": "https://tc.ayakasuki.com/a/2025/06/08/biji6844993874ee9.jpg",
        "alt": "土御门胡桃"
      }
    ];
    lastAvatarLoadTime = now;
    return avatarCache;
  }
}

/**
 * 生成用户唯一ID
 */
function generateUserId(fingerprint, timestamp) {
  const data = `${fingerprint}_${timestamp}_${Math.random()}`;
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  return `blog-${hash.substring(0, 8)}`;
}

/**
 * 管理员会话管理
 */
function setActiveAdminSession(blogUserId, masterQQ, token) {
  activeAdminSession = {
    blogUserId,
    masterQQ,
    loginTime: Date.now(),
    token
  };
  logInfo(`[ADMIN] 设置活跃管理员: ${masterQQ} -> ${blogUserId}`);
}

function clearActiveAdminSession() {
  if (activeAdminSession) {
    logInfo(`[ADMIN] 清除活跃管理员: ${activeAdminSession.masterQQ}`);
  }
  activeAdminSession = null;
}

/**
 * 心跳发送函数 - 优化：增加异常捕获，确保不影响主流程
 */
function sendHeartbeat() {
  if (!oneBotWs || oneBotWs.readyState !== WebSocket.OPEN) {
    logDebug('[HEARTBEAT] ❌ 连接未打开，跳过心跳');
    lastHeartbeatSuccess = false;
    return;
  }
  
  try {
    const heartbeat = {
      "post_type": "meta_event",
      "meta_event_type": "heartbeat",
      "self_id": parseInt(ONEBOT_SELF_ID),
      "time": Math.floor(Date.now() / 1000),
      "status": {
        "online": true,
        "good": true,
        "app_initialized": true,
        "app_enabled": true,
        "plugins_good": true,
        "app_good": true,
        "online": true
      },
      "interval": HEARTBEAT_INTERVAL
    };
    
    oneBotWs.send(JSON.stringify(heartbeat));
    lastHeartbeatTime = Date.now();
    lastHeartbeatSuccess = true;
    logDebug(`[HEARTBEAT] ✅ 心跳发送成功 (${new Date().toISOString()})`);
  } catch (error) {
    logError('[HEARTBEAT] ❌ 心跳发送失败:', error.message);
    lastHeartbeatSuccess = false;
    // 心跳发送失败时，先检查连接状态和重连状态，避免重复触发重连
    if (oneBotConnected && !isReconnecting) {
      // 延迟一小段时间后再重连，避免立即重连失败
      setTimeout(() => {
        if (oneBotConnected && !isReconnecting) {
          scheduleReconnect();
        }
      }, 1000);
    }
  }
}

/**
 * 检查心跳状态 - 优化：移除条件限制，每次都检查
 */
function checkHeartbeat() {
  const now = Date.now();
  const timeSinceLastHeartbeat = now - lastHeartbeatTime;
  
  if (lastHeartbeatTime > 0 && timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT) {
    logError(`[HEARTBEAT] ❌ 心跳超时 (${timeSinceLastHeartbeat}ms)`);
    logError('[HEARTBEAT] 最后成功心跳时间:', new Date(lastHeartbeatTime).toISOString());
    
    if (oneBotConnected && !isReconnecting) {
      logInfo('[HEARTBEAT] 心跳超时，立即触发重连');
      // 先尝试发送一个心跳包，看是否能恢复连接
      try {
        sendHeartbeat();
        // 等待2秒后再次检查，如果仍然超时则重连
        setTimeout(() => {
          const checkTime = Date.now();
          const checkSinceLastHeartbeat = checkTime - lastHeartbeatTime;
          if (checkSinceLastHeartbeat > HEARTBEAT_TIMEOUT && oneBotConnected && !isReconnecting) {
            logInfo('[HEARTBEAT] 二次检查仍超时，触发重连');
            scheduleReconnect();
          }
        }, 2000);
      } catch (e) {
        logError('[HEARTBEAT] 心跳发送失败，直接触发重连');
        scheduleReconnect();
      }
    }
  } else if (lastHeartbeatTime > 0) {
    logDebug(`[HEARTBEAT] ℹ️ 心跳正常 (${timeSinceLastHeartbeat}ms)`);
  }
}

/**
 * 计算重连延迟（指数退避+抖动）
 */
function calculateReconnectDelay() {
  const baseDelay = RECONNECT_BASE_DELAY;
  const maxDelay = RECONNECT_MAX_DELAY;
  // 关键修改：重连次数超过10次后，固定使用最大延迟
  const exp = Math.min(reconnectAttempts, 10);
  const exponentialDelay = baseDelay * Math.pow(2, exp - 1);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  
  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * 计划重连 - 关键修改：移除最大重连次数限制
 */
function scheduleReconnect() {
  if (isReconnecting) {
    logDebug('[RECONNECT] 已经在重连中，跳过');
    return;
  }
  
  isReconnecting = true;
  reconnectAttempts++;
  
  const delay = calculateReconnectDelay();
  logInfo(`[RECONNECT] 计划第 ${reconnectAttempts} 次重连，延迟 ${Math.round(delay)}ms`);
  logInfo(`[RECONNECT] 当前状态: oneBotConnected=${oneBotConnected}, isReconnecting=${isReconnecting}`);
  
  // 设置重连超时定时器，防止重连过程卡住
  const reconnectTimeoutId = setTimeout(() => {
    if (isReconnecting) {
      logError('[RECONNECT] 重连超时，重置重连状态');
      isReconnecting = false;
    }
  }, delay + 30000); // 重连超时时间：延迟时间 + 30秒
  
  setTimeout(() => {
    // 清除重连超时定时器
    clearTimeout(reconnectTimeoutId);
    
    // 再次检查状态，确保我们仍然需要重连
    if (!oneBotConnected) {
      logInfo(`[RECONNECT] 开始第 ${reconnectAttempts} 次重连...`);
      // 在调用connectOneBot之前重置isReconnecting标志
      isReconnecting = false;
      connectOneBot();
    } else {
      logInfo(`[RECONNECT] 跳过重连，OneBot后端已连接`);
      isReconnecting = false;
    }
  }, delay);
}

/**
 * 重置重连状态
 */
function resetReconnectState() {
  reconnectAttempts = 0;
  isReconnecting = false;
  lastHeartbeatSuccess = true;
  lastHeartbeatTime = Date.now();
  logInfo('[RECONNECT] 重连状态已重置');
}

/**
 * 启动心跳定时器 - 优化：增加异常捕获
 */
function startHeartbeatTimer() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  
  // 立即发送一次心跳
  sendHeartbeat();
  
  // 设置定期心跳
  heartbeatTimer = setInterval(() => {
    try {
      sendHeartbeat();
      checkHeartbeat(); // 关键修改：每次心跳都检查状态，不再限制3次
    } catch (error) {
      logError('[HEARTBEAT] 定时器执行失败:', error.message);
    }
  }, HEARTBEAT_INTERVAL);
  
  logInfo(`[HEARTBEAT] 心跳定时器已启动，间隔 ${HEARTBEAT_INTERVAL}ms`);
}

/**
 * 停止心跳定时器
 */
function stopHeartbeatTimer() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    logInfo('[HEARTBEAT] 心跳定时器已停止');
  }
}

/**
 * 启动连接看门狗 - 新增：独立检查连接状态
 */
function startWatchdogTimer() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }
  
  watchdogTimer = setInterval(() => {
    try {
      logDebug(`[WATCHDOG] 检查连接状态: oneBotConnected=${oneBotConnected}, isReconnecting=${isReconnecting}, heartbeatTimer=${!!heartbeatTimer}`);
      
      // 检查OneBot连接状态，如果未连接且不在重连中，触发重连
      if (!oneBotConnected && !isReconnecting) {
        logWarn('[WATCHDOG] 检测到OneBot连接丢失，触发重连');
        scheduleReconnect();
      }
      
      // 检查心跳定时器是否正常运行
      if (oneBotConnected && !heartbeatTimer) {
        logWarn('[WATCHDOG] 心跳定时器未运行，重新启动');
        startHeartbeatTimer();
      }
      
      // 额外检查：如果isReconnecting为true但长时间没有进展，重置状态
      if (isReconnecting) {
        const timeSinceLastReconnect = Date.now() - lastHeartbeatTime;
        if (timeSinceLastReconnect > 2 * HEARTBEAT_TIMEOUT) {
          logWarn('[WATCHDOG] 重连状态异常，重置isReconnecting标志');
          isReconnecting = false;
        }
      }
    } catch (error) {
      logError('[WATCHDOG] 看门狗执行失败:', error.message);
      // 即使出错，也要确保isReconnecting标志不会卡住
      if (isReconnecting) {
        logWarn('[WATCHDOG] 重置isReconnecting标志以避免卡住');
        isReconnecting = false;
      }
    }
  }, WATCHDOG_INTERVAL);
  
  logInfo(`[WATCHDOG] 连接看门狗已启动，检查间隔 ${WATCHDOG_INTERVAL}ms`);
}

/**
 * 停止看门狗定时器
 */
function stopWatchdogTimer() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    logInfo('[WATCHDOG] 看门狗定时器已停止');
  }
}

/**
 * 连接到 OneBot 后端 - 核心优化：增强稳定性，解耦前端依赖
 */
function connectOneBot() {
  if (isReconnecting) {
    logDebug('[ONEBOT] 重连进行中，跳过新的连接请求');
    return;
  }
  
  logInfo('[ONEBOT] 正在连接到 OneBot 后端...');
  
  try {
    const headers = {
      'Origin': 'https://ayakasuki.com',
      'User-Agent': 'Web-Onebot-Bridge/1.0.0'
    };
    
    if (ONEBOT_ACCESS_TOKEN) {
      headers['Authorization'] = `Bearer ${ONEBOT_ACCESS_TOKEN}`;
    }
    
    // 关闭已有连接
    if (oneBotWs) {
      try {
        oneBotWs.removeAllListeners();
        oneBotWs.close(1000, '重新连接');
      } catch (e) {
        logWarn('[ONEBOT] 关闭旧连接失败:', e.message);
      }
      oneBotWs = null;
    }
    
    // 设置连接超时定时器
    const connectionTimeoutId = setTimeout(() => {
      logError('[ONEBOT] ❌ 连接超时');
      if (oneBotWs) {
        try {
          oneBotWs.removeAllListeners();
          oneBotWs.close(1006, '连接超时');
        } catch (e) {
          logWarn('[ONEBOT] 关闭超时连接失败:', e.message);
        }
        oneBotWs = null;
      }
      oneBotConnected = false;
      isReconnecting = false;
      scheduleReconnect();
    }, 15000); // 15秒连接超时
    
    oneBotWs = new WebSocket(ONEBOT_WS_URL, {
      headers: headers,
      rejectUnauthorized: false,
      handshakeTimeout: 10000,
      maxPayload: 1024 * 1024 * 10 // 10MB
    });
    
    oneBotWs.on('open', () => {
      // 清除连接超时定时器
      clearTimeout(connectionTimeoutId);
      
      logInfo('[ONEBOT] ✅ 成功连接到 OneBot 后端');
      oneBotConnected = true;
      isReconnecting = false;
      resetReconnectState();
      
      // 发送生命周期事件
      const lifecycleEvent = {
        "post_type": "meta_event",
        "meta_event_type": "lifecycle",
        "sub_type": "connect",
        "self_id": parseInt(ONEBOT_SELF_ID),
        "time": Math.floor(Date.now() / 1000)
      };
      
      try {
        oneBotWs.send(JSON.stringify(lifecycleEvent));
        logInfo('[ONEBOT] 发送生命周期事件');
      } catch (e) {
        logError('[ONEBOT] 发送生命周期事件失败:', e.message);
      }
      
      // 启动心跳定时器
      startHeartbeatTimer();
    });
    
    oneBotWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // 更新最后心跳时间
        lastHeartbeatTime = Date.now();
        
        logMessageSummary('[ONEBOT] 收到消息', message, 'receive');
        
        if (LOG_CONFIG.logLevel === 'debug') {
          logCompressedMessage('[ONEBOT] 消息详情', message, 'data');
        }
        
        // 消息处理失败不再影响连接，仅记录错误
        try {
          if (message.action === "send_msg" && message.params && message.params.user_id) {
            const userId = message.params.user_id.toString();
            
            if (userId === REAL_MASTER_QQ || userId.startsWith('blog-')) {
              logInfo(`[ONEBOT] 🎯 识别为目标用户消息: ${userId}`);
              await handleOneBotEvent(message);
              return;
            }
          }
          
          if (message.action) {
            logDebug(`[ONEBOT] 识别为 API 请求: ${message.action}`);
            handleOneBotApiRequest(message);
            return;
          }
          
          if (message.post_type) {
            logInfo(`[ONEBOT] 识别为事件上报: ${message.post_type}`);
            await handleOneBotEvent(message);
            return;
          }
          
          logDebug('[ONEBOT] 处理为响应数据');
          await handleOneBotEvent(message);
        } catch (e) {
          logError('[ONEBOT] 消息路由失败（不影响连接）:', e.message);
        }
        
      } catch (error) {
        logError('[ONEBOT] 消息解析失败:', error.message);
        // 消息解析失败不关闭连接，仅记录错误
      }
    });
    
    oneBotWs.on('close', (code, reason) => {
      // 清除连接超时定时器
      clearTimeout(connectionTimeoutId);
      
      logError(`[ONEBOT] ❌ 连接关闭 (代码: ${code}, 原因: ${reason || '无'})`);
      oneBotConnected = false;
      
      // 停止心跳定时器
      stopHeartbeatTimer();
      
      // 所有异常关闭都重连（除了1000正常关闭）
      if (code !== 1000) {
        logInfo(`[ONEBOT] 异常关闭，计划重连`);
        scheduleReconnect();
      } else {
        logInfo('[ONEBOT] 正常关闭，不重连');
        isReconnecting = false;
      }
    });
    
    oneBotWs.on('error', (error) => {
      // 清除连接超时定时器
      clearTimeout(connectionTimeoutId);
      
      logError('[ONEBOT] ❌ 连接错误:', error.message);
      oneBotConnected = false;
      
      // 所有错误都触发重连
      logInfo('[ONEBOT] 连接错误，计划重连');
      // 确保isReconnecting标志被重置，避免重连被阻止
      isReconnecting = false;
      scheduleReconnect();
    });
    
    // 监听连接超时
    oneBotWs.on('unexpected-response', (req, res) => {
      // 清除连接超时定时器
      clearTimeout(connectionTimeoutId);
      
      logError(`[ONEBOT] ❌ 连接响应异常 (状态码: ${res.statusCode})`);
      oneBotConnected = false;
      scheduleReconnect();
    });
    
  } catch (error) {
    logError('[ONEBOT] 创建连接失败:', error.message);
    oneBotConnected = false;
    // 确保isReconnecting标志被重置，避免重连被阻止
    isReconnecting = false;
    scheduleReconnect();
  }
}

/**
 * 处理 OneBot API 请求
 */
function handleOneBotApiRequest(request) {
  const response = {
    status: "ok",
    retcode: 0,
    echo: request.echo,
    data: null
  };
  
  switch (request.action) {
    case "get_login_info":
      response.data = {
        user_id: parseInt(ONEBOT_SELF_ID),
        nickname: ONEBOT_BOT_NAME
      };
      break;
      
    case "get_version_info":
      response.data = {
        app_name: "Web-Onebot-Bridge",
        app_version: "1.0.0",
        protocol_version: "v11"
      };
      break;
      
    case "get_friend_list":
      response.data = [];
      break;
      
    case "get_group_list":
      response.data = [];
      break;
      
    default:
      response.data = { result: true };
  }
  
  if (oneBotWs && oneBotWs.readyState === WebSocket.OPEN) {
    try {
      oneBotWs.send(JSON.stringify(response));
      logMessageSummary('[ONEBOT] 发送API响应', response, 'send');
    } catch (e) {
      logError('[ONEBOT] 发送API响应失败:', e.message);
    }
  } else {
    logWarn('[ONEBOT] 无法发送API响应，连接未打开');
  }
}

/**
 * 处理 OneBot 消息路由 - 关键修改：解耦前端依赖，消息处理失败不影响连接
 */
async function handleOneBotEvent(event) {
  try {
    logInfo('[FORWARD] 开始处理 OneBot 消息');
    
    let targetUserId = null;
    let forwardData = event;
    
    if (event.action === "send_msg" && event.params && event.params.user_id) {
      targetUserId = event.params.user_id.toString();
      
      if (targetUserId === REAL_MASTER_QQ) {
        logInfo('[ADMIN] 🎯 识别为发送给管理员的消息');
        
        if (activeAdminSession) {
          targetUserId = activeAdminSession.blogUserId;
          logInfo(`[ADMIN] 路由管理员消息到: ${targetUserId}`);
        } else {
          try {
            const activeAdminId = await client.get('active_admin');
            if (activeAdminId && onlineUsers.has(activeAdminId)) {
              const sessionData = await client.get(`admin_session:${activeAdminId}`);
              if (sessionData) {
                const session = JSON.parse(sessionData);
                setActiveAdminSession(session.blogUserId, session.masterQQ, session.token);
                targetUserId = session.blogUserId;
                logInfo(`[ADMIN] 从Redis恢复管理员会话: ${targetUserId}`);
              } else {
                logWarn('[ADMIN] ❌ 无活跃管理员，忽略消息');
                return;
              }
            } else {
              logWarn('[ADMIN] ❌ 无活跃管理员，忽略消息');
              return;
            }
          } catch (error) {
            logError('[ADMIN] Redis恢复失败:', error.message);
            return;
          }
        }
      }
    } else if (event.post_type === 'message' && event.user_id) {
      targetUserId = event.user_id.toString();
    } else if (event.data && typeof event.data === 'object' && event.data.user_id) {
      targetUserId = event.data.user_id.toString();
    }
    
    if (!targetUserId) {
      logWarn('[FORWARD] ❌ 无法提取目标用户ID');
      if (LOG_CONFIG.logLevel === 'debug') {
        logCompressedMessage('[FORWARD] 原始事件', event);
      }
      return;
    }
    
    if (!targetUserId.startsWith('blog-')) {
      logWarn(`[FORWARD] ❌ 目标用户不是 blog- 格式: ${targetUserId}`);
      return;
    }
    
    const userWs = onlineUsers.get(targetUserId);
    if (!userWs) {
      logWarn(`[FORWARD] ❌ 用户不在线: ${targetUserId}`);
      return;
    }
    
    if (userWs.readyState !== WebSocket.OPEN) {
      logWarn(`[FORWARD] ❌ 用户 WebSocket 未打开: ${userWs.readyState}`);
      return;
    }
    
    logInfo('[FORWARD] ✅ 准备转发消息给:', targetUserId);
    
    if (LOG_CONFIG.logLevel === 'debug') {
      logCompressedMessage('[FORWARD] 转发消息', forwardData);
    }
    
    userWs.send(JSON.stringify(forwardData));
    logInfo(`[FORWARD] ✅ 成功转发给 ${targetUserId}`);
    
    if (event.action && event.echo) {
      const apiResponse = {
        status: "ok",
        retcode: 0,
        echo: event.echo,
        data: {
          message_id: Math.floor(Math.random() * 1000000)
        }
      };
      
      if (oneBotWs && oneBotWs.readyState === WebSocket.OPEN) {
        try {
          oneBotWs.send(JSON.stringify(apiResponse));
          logInfo(`[ONEBOT] ✅ 发送API响应 (echo: ${event.echo})`);
        } catch (e) {
          logError('[ONEBOT] 发送API响应失败:', e.message);
        }
      }
    }
    
  } catch (error) {
    logError(`[FORWARD] ❌ 转发失败（不影响OneBot连接）:`, error.message);
    
    if (event.action && event.echo && oneBotWs && oneBotWs.readyState === WebSocket.OPEN) {
      try {
        oneBotWs.send(JSON.stringify({
          status: "failed",
          retcode: 1000,
          echo: event.echo,
          data: null
        }));
        logInfo(`[ONEBOT] ✅ 发送失败响应 (echo: ${event.echo})`);
      } catch (e) {
        logError('[ONEBOT] 发送失败响应失败:', e.message);
      }
    }
  }
}

/**
 * 创建 WebSocket 服务器供前端连接
 */
function createWebSocketServer(server) {
  wss = new WebSocketServer({ 
    server,
    path: '/ws'
  });
  
  logInfo('[WS] WebSocket 服务器创建完成');
  
  wss.on('connection', (ws, req) => {
    const userId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('userId');
    
    if (!userId || !userId.startsWith('blog-')) {
      logWarn(`[WS] ❌ 无效的用户ID: ${userId}`);
      ws.close(1008, 'Invalid userId');
      return;
    }
    
    logInfo(`[WS] ✅ 用户连接成功: ${userId}`);
    onlineUsers.set(userId, ws);
    
    // 关键修改：发送连接事件时增加异常捕获
    try {
      ws.send(JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
        self_id: ONEBOT_SELF_ID,
        nickname: ONEBOT_BOT_NAME
      }));
    } catch (e) {
      logError(`[WS] 发送连接事件失败: ${e.message}`);
    }
    
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        logMessageSummary(`[WS] 收到来自 ${userId} 的消息`, message, 'receive');
        
        // 过滤掉前端发送的心跳和认证消息，这些由app.js自己处理
        if (message.meta_event_type === 'heartbeat') {
          logDebug(`[WS] 过滤掉前端心跳消息，由app.js独立处理`);
          return;
        }
        
        if (message.meta_event_type === 'lifecycle' && message.sub_type === 'connect') {
          logDebug(`[WS] 过滤掉前端认证消息，由app.js独立处理`);
          return;
        }
        
        let forwardMessage = { ...message };
        
        if (activeAdminSession && activeAdminSession.blogUserId === userId) {
          logInfo(`[ADMIN] 管理员模式发送消息: ${userId}`);
          if (forwardMessage.user_id) {
            forwardMessage.user_id = parseInt(REAL_MASTER_QQ);
          }
          if (forwardMessage.sender && forwardMessage.sender.user_id) {
            forwardMessage.sender.user_id = parseInt(REAL_MASTER_QQ);
          }
        }
        
        forwardMessage.self_id = parseInt(ONEBOT_SELF_ID);
        
        if (oneBotWs && oneBotWs.readyState === WebSocket.OPEN) {
          try {
            oneBotWs.send(JSON.stringify(forwardMessage));
            logInfo(`[BRIDGE] 转发消息到 OneBot 后端`);
            
            if (LOG_CONFIG.logLevel === 'debug') {
              logCompressedMessage('[BRIDGE] 转发详情', forwardMessage);
            }
          } catch (e) {
            logError(`[BRIDGE] 转发失败: ${e.message}`);
            ws.send(JSON.stringify({
              post_type: 'system',
              message: '机器人消息发送失败'
            }));
          }
        } else {
          logWarn('[BRIDGE] OneBot 后端未连接');
          ws.send(JSON.stringify({
            post_type: 'system',
            message: '机器人未连接，消息发送失败'
          }));
        }
      } catch (error) {
        logError(`[WS] 消息处理失败:`, error.message);
        // 前端消息处理失败不影响OneBot后端连接
      }
    });
    
    ws.on('close', (code, reason) => {
      logInfo(`[WS] ❌ 用户断开: ${userId} (代码: ${code}, 原因: ${reason || '无'})`);
      onlineUsers.delete(userId);
      
      if (activeAdminSession && activeAdminSession.blogUserId === userId) {
        clearActiveAdminSession();
        client.del('active_admin');
        logInfo('[ADMIN] 管理员连接断开，清理会话');
      }
      
      // 前端断开连接时，不影响OneBot后端的连接
      logDebug('[WS] 前端断开连接，OneBot后端连接状态保持不变:', oneBotConnected);
    });
    
    ws.on('error', (error) => {
      logError(`[WS] 用户 ${userId} 错误:`, error.message);
      onlineUsers.delete(userId);
      
      if (activeAdminSession && activeAdminSession.blogUserId === userId) {
        clearActiveAdminSession();
        client.del('active_admin');
      }
      
      // 前端错误时，不影响OneBot后端的连接
      logDebug('[WS] 前端连接错误，OneBot后端连接状态保持不变:', oneBotConnected);
    });
  });
  
  logInfo('[WS] WebSocket 服务器启动完成');
}

/**
 * API 接口 - 保留原有业务逻辑
 */
app.post('/api/user/init', async (req, res) => {
  try {
    const { fingerprint, timestamp } = req.body;
    
    if (!fingerprint || !timestamp) {
      return res.status(400).json({
        success: false,
        message: '参数不完整'
      });
    }
    
    const existingToken = req.headers['x-auth-token'];
    if (existingToken) {
      const tokenData = await client.get(`user_token:${existingToken}`);
      if (tokenData) {
        const userInfo = JSON.parse(tokenData);
        if (userInfo.fingerprint === fingerprint) {
          return res.json({
            success: true,
            userId: userInfo.userId,
            avatar: userInfo.avatar,
            token: existingToken,
            isNew: false
          });
        }
      }
    }
    
    const userId = generateUserId(fingerprint, timestamp);
    const avatars = await getAvatarList();
    const randomAvatar = avatars[Math.floor(Math.random() * avatars.length)];
    const userToken = crypto.randomBytes(16).toString('hex');
    
    const tokenData = {
      userId,
      avatar: randomAvatar,
      fingerprint,
      createdAt: new Date().toISOString(),
      ip: req.ip,
      nickname: '用户'
    };
    
    await client.setEx(`user_token:${userToken}`, 2592000, JSON.stringify(tokenData));
    userInfoMap.set(userId, tokenData);
    
    res.json({
      success: true,
      userId,
      avatar: randomAvatar,
      token: userToken,
      isNew: true
    });
    
  } catch (error) {
    logError('[USER INIT ERROR] 用户初始化失败:', error.message);
    res.status(500).json({
      success: false,
      message: '用户初始化失败'
    });
  }
});

app.get('/api/user/verify', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).json({
        valid: false,
        message: '令牌不能为空'
      });
    }
    
    const tokenData = await client.get(`user_token:${token}`);
    
    if (!tokenData) {
      return res.json({
        valid: false,
        message: '令牌无效或已过期'
      });
    }
    
    const userInfo = JSON.parse(tokenData);
    await client.expire(`user_token:${token}`, 2592000);
    userInfoMap.set(userInfo.userId, userInfo);
    
    res.json({
      valid: true,
      userId: userInfo.userId,
      avatar: userInfo.avatar,
      createdAt: userInfo.createdAt
    });
    
  } catch (error) {
    logError('[USER VERIFY ERROR] 令牌验证出错:', error.message);
    res.status(500).json({
      valid: false,
      message: '服务器内部错误'
    });
  }
});

app.post('/auth/master', async (req, res) => {
  try {
    const { account, password, blogUserId } = req.body;
    
    if (!account || !password) {
      return res.status(400).json({
        success: false,
        message: '账号和密码不能为空'
      });
    }
    
    logInfo(`[AUTH] 管理员登录请求: ${account}, IP: ${req.ip}`);
    
    if (account !== ADMIN_ACCOUNT) {
      logWarn(`[AUTH] 账号不存在: ${account}`);
      return res.status(401).json({
        success: false,
        message: '账号或密码错误'
      });
    }
    
    if (password !== MASTER_PASSWORD) {
      logWarn(`[AUTH] 密码错误, 账号: ${account}`);
      return res.status(401).json({
        success: false,
        message: '账号或密码错误'
      });
    }
    
    let targetBlogUserId = blogUserId;
    
    if (!targetBlogUserId) {
      const userToken = req.headers['x-auth-token'];
      if (userToken) {
        const userTokenData = await client.get(`user_token:${userToken}`);
        if (userTokenData) {
          const userInfo = JSON.parse(userTokenData);
          targetBlogUserId = userInfo.userId;
          logInfo(`[AUTH] 从用户token获取blogUserId: ${targetBlogUserId}`);
        }
      }
    }
    
    if (!targetBlogUserId) {
      if (onlineUsers.size > 0) {
        targetBlogUserId = Array.from(onlineUsers.keys())[0];
        logInfo(`[AUTH] 使用第一个在线用户作为blogUserId: ${targetBlogUserId}`);
      } else {
        return res.status(400).json({
          success: false,
          message: '无法确定用户会话，请确保用户已初始化'
        });
      }
    }
    
    if (!targetBlogUserId.startsWith('blog-') || !onlineUsers.has(targetBlogUserId)) {
      return res.status(400).json({
        success: false,
        message: '用户会话无效或已过期'
      });
    }
    
    const authToken = crypto.randomBytes(16).toString('hex');
    setActiveAdminSession(targetBlogUserId, REAL_MASTER_QQ, authToken);
    
    const sessionData = {
      account: account,
      realMasterQQ: REAL_MASTER_QQ,
      blogUserId: targetBlogUserId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL * 1000).toISOString(),
      ip: req.ip
    };
    
    await client.setEx(`${ADMIN_SESSION_PREFIX}${authToken}`, ADMIN_SESSION_TTL, JSON.stringify(sessionData));
    await client.setEx('active_admin', ADMIN_SESSION_TTL, targetBlogUserId);
    
    logInfo(`[AUTH] 管理员 ${account} 登录成功, 关联用户: ${targetBlogUserId}`);
    
    res.json({
      success: true,
      message: '认证成功',
      token: authToken,
      realMasterQQ: REAL_MASTER_QQ,
      blogUserId: targetBlogUserId,
      expiresIn: ADMIN_SESSION_TTL
    });
    
  } catch (error) {
    logError('[AUTH ERROR] 认证过程出错:', error.message);
    res.status(500).json({
      success: false,
      message: '服务器内部错误'
    });
  }
});

app.get('/auth/verify', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).json({
        valid: false,
        message: '令牌不能为空'
      });
    }
    
    const tokenData = await client.get(`${ADMIN_SESSION_PREFIX}${token}`);
    
    if (!tokenData) {
      return res.json({
        valid: false,
        message: '令牌无效或已过期'
      });
    }
    
    const tokenInfo = JSON.parse(tokenData);
    
    if (!onlineUsers.has(tokenInfo.blogUserId)) {
      await client.del(`${ADMIN_SESSION_PREFIX}${token}`);
      await client.del('active_admin');
      clearActiveAdminSession();
      
      return res.json({
        valid: false,
        message: '用户会话已过期'
      });
    }
    
    await client.expire(`${ADMIN_SESSION_PREFIX}${token}`, ADMIN_SESSION_TTL);
    await client.expire('active_admin', ADMIN_SESSION_TTL);
    
    res.json({
      valid: true,
      account: tokenInfo.account,
      realMasterQQ: tokenInfo.realMasterQQ,
      blogUserId: tokenInfo.blogUserId,
      createdAt: tokenInfo.createdAt,
      expiresAt: tokenInfo.expiresAt
    });
    
  } catch (error) {
    logError('[VERIFY ERROR] 令牌验证出错:', error.message);
    res.status(500).json({
      valid: false,
      message: '服务器内部错误'
    });
  }
});

app.post('/auth/logout', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        message: '令牌不能为空'
      });
    }
    
    if (activeAdminSession && activeAdminSession.token === token) {
      clearActiveAdminSession();
      await client.del('active_admin');
      await client.del(`${ADMIN_SESSION_PREFIX}${token}`);
      logInfo('[ADMIN] 管理员主动退出');
    } else {
      await client.del(`${ADMIN_SESSION_PREFIX}${token}`);
    }
    
    res.json({
      success: true,
      message: '注销成功'
    });
    
  } catch (error) {
    logError('[LOGOUT ERROR] 注销过程出错:', error.message);
    res.status(500).json({
      success: false,
      message: '服务器内部错误'
    });
  }
});

app.get('/auth/admin/status', async (req, res) => {
  try {
    if (!activeAdminSession) {
      return res.json({ 
        isActive: false, 
        message: '无活跃管理员' 
      });
    }
    
    const userWs = onlineUsers.get(activeAdminSession.blogUserId);
    if (!userWs || userWs.readyState !== WebSocket.OPEN) {
      clearActiveAdminSession();
      await client.del('active_admin');
      return res.json({ 
        isActive: false, 
        message: '连接已断开' 
      });
    }
    
    res.json({
      isActive: true,
      masterQQ: activeAdminSession.masterQQ,
      blogUserId: activeAdminSession.blogUserId,
      loginTime: new Date(activeAdminSession.loginTime).toISOString()
    });
    
  } catch (error) {
    logError('[ADMIN STATUS ERROR] 检查失败:', error.message);
    res.status(500).json({
      isActive: false,
      message: '检查过程出错'
    });
  }
});

app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    service: 'ChatBot Bridge Service',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      userInit: '/api/user/init',
      userVerify: '/api/user/verify',
      auth: '/auth/master',
      verify: '/auth/verify',
      logout: '/auth/logout',
      adminStatus: '/auth/admin/status',
      health: '/health'
    },
    features: {
      userManagement: 'active',
      adminAuth: 'active',
      avatarService: 'active',
      tokenValidation: 'active',
      oneBotBridge: oneBotConnected ? 'connected' : 'disconnected',
      onlineUsers: onlineUsers.size
    },
    oneBot: {
      connected: oneBotConnected,
    //   selfId: ONEBOT_SELF_ID,
    //   url: ONEBOT_WS_URL
    },
    adminSession: activeAdminSession ? {
      masterQQ: activeAdminSession.masterQQ,
      blogUserId: activeAdminSession.blogUserId,
      loginTime: new Date(activeAdminSession.loginTime).toISOString()
    } : null
  });
});

app.get('/health', async (req, res) => {
  try {
    await client.ping();
    
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        redis: 'connected',
        api: 'running',
        authentication: 'active',
        oneBot: oneBotConnected ? 'connected' : 'disconnected',
        webSocket: 'running'
      },
      uptime: process.uptime(),
      onlineUsers: onlineUsers.size,
      adminSession: activeAdminSession ? 'active' : 'inactive',
      heartbeat: {
        lastHeartbeatTime: lastHeartbeatTime > 0 ? new Date(lastHeartbeatTime).toISOString() : null,
        heartbeatStatus: lastHeartbeatTime > 0 ? (Date.now() - lastHeartbeatTime < HEARTBEAT_TIMEOUT ? 'healthy' : 'timeout') : 'unknown',
        reconnectAttempts: reconnectAttempts,
        isReconnecting: isReconnecting
      },
      watchdog: {
        running: !!watchdogTimer,
        interval: WATCHDOG_INTERVAL
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      message: 'Redis connection failed',
      error: error.message
    });
  }
});

app.get('/api/avatars', async (req, res) => {
  try {
    const avatars = await getAvatarList();
    res.json({
      success: true,
      avatars: avatars,
      count: avatars.length
    });
  } catch (error) {
    logError('[AVATARS ERROR] 获取头像列表失败:', error.message);
    res.status(500).json({
      success: false,
      message: '获取头像列表失败'
    });
  }
});

app.post('/admin/cleanup', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: '需要管理员令牌'
      });
    }
    
    const token = authHeader.substring(7);
    const tokenData = await client.get(`auth_token:${token}`);
    
    if (!tokenData) {
      return res.status(401).json({
        success: false,
        message: '无效的管理员令牌'
      });
    }
    
    const keys = await client.keys('user_token:*');
    let cleaned = 0;
    
    for (const key of keys) {
      const ttl = await client.ttl(key);
      if (ttl < 0) {
        await client.del(key);
        cleaned++;
      }
    }
    
    res.json({
      success: true,
      message: '清理任务已执行',
      cleanedTokens: cleaned,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logError('[CLEANUP ERROR] 清理过程出错:', error.message);
    res.status(500).json({
      success: false,
      message: '清理过程失败'
    });
  }
});

app.get('/', (req, res) => {
  res.redirect('/status');
});

/**
 * 启动服务器 - 关键修改：启动看门狗定时器
 */
async function startServer() {
  try {
    let server;
    
    if (NODE_ENV === 'production') {
      try {
        const sslOptions = {
          key: fs.readFileSync(SSL_KEY_PATH),
          cert: fs.readFileSync(SSL_CERT_PATH)
        };
        
        server = https.createServer(sslOptions, app);
        console.log(`🔐 SSL证书加载成功:`);
        console.log(`   - 证书路径: ${SSL_CERT_PATH}`);
        console.log(`   - 密钥路径: ${SSL_KEY_PATH}`);
      } catch (sslError) {
        console.error(`❌ SSL证书加载失败: ${sslError.message}`);
        console.error('💡 请确保证书文件存在，或设置SSL_CERT_PATH和SSL_KEY_PATH环境变量');
        process.exit(1);
      }
    } else {
      server = http.createServer(app);
      console.log(`⚠️  开发模式: 使用HTTP (非加密连接)`);
    }
    
    createWebSocketServer(server);
    
    // 初始连接OneBot后端
    connectOneBot();
    
    // 启动连接看门狗
    startWatchdogTimer();
    
    // 定期清理过期管理员会话
    setInterval(async () => {
      const now = Date.now();
      if (activeAdminSession && (now - activeAdminSession.loginTime > 24 * 60 * 60 * 1000)) {
        logInfo(`[ADMIN] 清理过期管理员会话: ${activeAdminSession.masterQQ}`);
        clearActiveAdminSession();
        await client.del('active_admin');
      }
    }, 60 * 60 * 1000);
    
    server.listen(PORT, () => {
      const protocol = NODE_ENV === 'production' ? 'https' : 'http';
      console.log(`🚀 桥接服务运行在 ${protocol}://localhost:${PORT}`);
      console.log(`🔐 认证端点: POST ${protocol}://localhost:${PORT}/auth/master`);
      console.log(`👤 用户初始化: POST ${protocol}://localhost:${PORT}/api/user/init`);
      console.log(`🔧 运行模式: ${NODE_ENV}`);
      console.log(`📊 日志级别: ${LOG_LEVEL}`);
      console.log(`⏰ 启动时间: ${new Date().toISOString()}`);
      console.log(`🤖 OneBot 机器人: ${ONEBOT_SELF_ID}`);
      console.log(`🔗 OneBot 后端: ${ONEBOT_WS_URL}`);
      console.log(`💡 WebSocket 路径: ${protocol}://localhost:${PORT}/ws?userId=blog-xxx`);
      console.log(`👑 管理员会话管理: 已启用`);
      console.log(`📊 日志压缩: 已启用 (数据最大长度: ${LOG_CONFIG.maxDataLength}字符)`);
      console.log(`❤️  心跳检测: 已启用 (间隔: ${HEARTBEAT_INTERVAL}ms, 超时: ${HEARTBEAT_TIMEOUT}ms)`);
      console.log(`🐶 连接看门狗: 已启用 (检查间隔: ${WATCHDOG_INTERVAL}ms)`);
      console.log(`🔄 自动重连: 已启用 (无次数限制，指数退避延迟)`);
    });
    
    // 优雅关闭
    process.on('SIGTERM', () => {
      logInfo('🛑 收到SIGTERM信号，正在关闭服务...');
      stopHeartbeatTimer();
      stopWatchdogTimer(); // 停止看门狗
      if (oneBotWs) oneBotWs.close(1000, '正常关闭');
      if (wss) wss.close();
      server.close(() => {
        logInfo('👋 服务已关闭');
        process.exit(0);
      });
    });
    
    process.on('SIGINT', () => {
      logInfo('🛑 收到SIGINT信号，正在关闭服务...');
      stopHeartbeatTimer();
      stopWatchdogTimer(); // 停止看门狗
      if (oneBotWs) oneBotWs.close(1000, '正常关闭');
      if (wss) wss.close();
      server.close(() => {
        logInfo('👋 服务已关闭');
        process.exit(0);
      });
    });
    
  } catch (error) {
    logError('❌ 服务器启动失败:', error.message);
    process.exit(1);
  }
}

// 启动服务器
startServer().catch(console.error);

export default app;