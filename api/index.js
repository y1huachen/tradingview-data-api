// 加载环境变量（从 .env 文件）
require('dotenv').config();

const express = require('express');
const { ProxyAgent } = require('undici');
const { Readable } = require('stream'); // 用于将文本转换为可读流
const csv = require('csv-parser');      // CSV解析器

const app = express();
const PORT = process.env.PORT || 3000;

// **重要：请将此变量替换为你的 Google Sheets CSV 公开链接**
const GOOGLE_SHEETS_CSV_URL = process.env.SHEETS_URL || "https://docs.google.com/spreadsheets/d/e/2PACX-1vRCQma2eHSzsyxCuDpbJFMHZGo3aF3g3m54y_7M9wdOus4WcdqB7Ge1CeJNKPMlRjnmRDyJvZgkNEQG/pub?output=csv";

// 代理配置（支持环境变量或直接配置）
// 格式: http://username:password@host:port 或 http://host:port
// 优先级: PROXY_URL > HTTPS_PROXY > HTTP_PROXY
const PROXY_URL = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

// 创建代理 dispatcher（如果配置了代理）
let proxyDispatcher = null;
if (PROXY_URL) {
    try {
        proxyDispatcher = new ProxyAgent(PROXY_URL);
        // 隐藏代理URL中的密码信息
        const maskedUrl = PROXY_URL.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
        console.log(`已配置代理: ${maskedUrl}`);
    } catch (error) {
        console.warn('代理配置无效，将不使用代理:', error.message);
    }
}

// 简易内存缓存，避免频繁请求 Sheets API，提升速度并避免配额限制
let cache = {
    data: null,
    timestamp: 0,
};
const CACHE_DURATION = 60 * 1000; // 缓存1分钟

async function fetchLatestDataFromSheets() {
    const now = Date.now();
    if (cache.data && (now - cache.timestamp) < CACHE_DURATION) {
        console.log('返回缓存数据');
        return cache.data;
    }

    console.log('从 Google Sheets 获取新数据...');
    try {
        // 配置 fetch 选项，如果使用代理则添加 dispatcher
        const fetchOptions = {};
        if (proxyDispatcher) {
            fetchOptions.dispatcher = proxyDispatcher;
        }
        
        const response = await fetch(GOOGLE_SHEETS_CSV_URL, fetchOptions);
        if (!response.ok) {
            throw new Error(`Google Sheets 请求失败: ${response.status} ${response.statusText}`);
        }
        const csvText = await response.text();

        // 使用 csv-parser 库解析CSV文本流
        const rows = [];
        await new Promise((resolve, reject) => {
            // 将字符串转换为可读流，这是csv-parser要求的输入格式
            const readableStream = Readable.from(csvText);
            readableStream
                .pipe(csv()) // 使用csv-parser，它会自动处理引号内的换行符和逗号
                .on('data', (row) => {
                    // 处理可能的零宽空格等不可见字符
                    const cleanRow = {};
                    for (const key in row) {
                        cleanRow[key] = row[key].replace(/\u200b/g, '').trim(); // 移除零宽空格并修整
                    }
                    rows.push(cleanRow);
                })
                .on('end', () => {
                    console.log(`CSV解析完成，共 ${rows.length} 行数据。`);
                    resolve();
                })
                .on('error', (error) => {
                    console.error('CSV解析过程出错:', error);
                    reject(error);
                });
        });

        if (rows.length > 0) {
            const latestRow = rows[rows.length - 1]; // 获取最新的一行
            console.log(`成功获取最新数据，时间戳为: ${latestRow.Timestamp}`);
            // 更新缓存
            cache = {
                data: latestRow,
                timestamp: now
            };
            return latestRow;
        } else {
            throw new Error('解析后未获得任何数据行');
        }

    } catch (error) {
        console.error('获取或解析数据时出错:', error);
        // 即使出错，也返回旧的缓存数据（如果有），保证服务不中断
        return cache.data || { error: error.message };
    }
}

// 定义API主端点
app.get('/api/latest', async (req, res) => {
    try {
        const data = await fetchLatestDataFromSheets();
        // 设置CORS头，允许TradingView或其他网页调用（根据需求调整）
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: '内部服务器错误' });
    }
});

// 健康检查端点，用于部署后验证
app.get('/', (req, res) => {
    res.send('TradingView 数据 API 服务运行正常。请访问 /api/latest');
});

// 本地启动服务器
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`API 服务本地运行在: http://localhost:${PORT}`);
    });
}

// 导出app，用于Vercel等Serverless平台
module.exports = app;