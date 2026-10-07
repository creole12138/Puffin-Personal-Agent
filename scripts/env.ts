// 读取 .env（Node 22 内置），不存在则忽略
try { process.loadEnvFile(".env"); } catch {}
