import redis from 'redis';
import YAML from 'yaml';
import fs from 'node:fs';

const config = YAML.parse(fs.readFileSync('./config/redis.yaml', 'utf8'));

const client = redis.createClient({
    url: `redis://${config.host}:${config.port}`,
    password: config.password,
    database: config.db  // 确保配置文件中有 db: 6
});

client.on('error', (err) => {
    console.error('Redis error:', err);
});

client.connect().then(() => {
    console.log(`Connected to Redis DB: ${config.db}`);
}).catch(console.error);

export default client;
