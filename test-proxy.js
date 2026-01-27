/**
 * Proxy Test Script
 * Tests the Oxylabs proxy connection
 */

require('dotenv').config();
const http = require('http');
const https = require('https');

const PROXY_HOST = process.env.PROXY_SERVER?.split(':')[0] || 'pr.oxylabs.io';
const PROXY_PORT = parseInt(process.env.PROXY_SERVER?.split(':')[1]) || 7777;
const PROXY_USER = process.env.PROXY_USERNAME;
const PROXY_PASS = process.env.PROXY_PASSWORD;

console.log('═'.repeat(50));
console.log('PROXY TEST');
console.log('═'.repeat(50));
console.log(`Host: ${PROXY_HOST}`);
console.log(`Port: ${PROXY_PORT}`);
console.log(`User: ${PROXY_USER}`);
console.log(`Pass: ${PROXY_PASS}`);
console.log('═'.repeat(50));

// Method 1: Basic Auth in header
function testMethod1() {
    return new Promise((resolve, reject) => {
        console.log('\n[Method 1] Testing Basic Auth header...');

        const auth = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');

        const req = http.request({
            host: PROXY_HOST,
            port: PROXY_PORT,
            method: 'CONNECT',
            path: 'api.ipify.org:443',
            headers: {
                'Proxy-Authorization': `Basic ${auth}`,
                'Host': 'api.ipify.org:443'
            },
            timeout: 15000
        });

        req.on('connect', (res, socket) => {
            console.log(`  CONNECT status: ${res.statusCode}`);
            if (res.statusCode === 200) {
                // Make HTTPS request through tunnel
                const httpsReq = https.request({
                    hostname: 'api.ipify.org',
                    path: '/?format=json',
                    method: 'GET',
                    socket: socket,
                    agent: false
                }, (response) => {
                    let data = '';
                    response.on('data', chunk => data += chunk);
                    response.on('end', () => {
                        console.log(`  ✅ SUCCESS! Response: ${data}`);
                        resolve(data);
                    });
                });
                httpsReq.on('error', e => {
                    console.log(`  ❌ HTTPS error: ${e.message}`);
                    reject(e);
                });
                httpsReq.end();
            } else {
                console.log(`  ❌ CONNECT failed: ${res.statusCode}`);
                reject(new Error(`Status ${res.statusCode}`));
            }
        });

        req.on('error', (e) => {
            console.log(`  ❌ Request error: ${e.message}`);
            reject(e);
        });

        req.on('timeout', () => {
            console.log('  ❌ Timeout');
            req.destroy();
            reject(new Error('Timeout'));
        });

        req.end();
    });
}

// Method 2: auth option in request
function testMethod2() {
    return new Promise((resolve, reject) => {
        console.log('\n[Method 2] Testing auth option...');

        const req = http.request({
            host: PROXY_HOST,
            port: PROXY_PORT,
            method: 'CONNECT',
            path: 'api.ipify.org:443',
            auth: `${PROXY_USER}:${PROXY_PASS}`,
            timeout: 15000
        });

        req.on('connect', (res, socket) => {
            console.log(`  CONNECT status: ${res.statusCode}`);
            if (res.statusCode === 200) {
                const httpsReq = https.request({
                    hostname: 'api.ipify.org',
                    path: '/?format=json',
                    method: 'GET',
                    socket: socket,
                    agent: false
                }, (response) => {
                    let data = '';
                    response.on('data', chunk => data += chunk);
                    response.on('end', () => {
                        console.log(`  ✅ SUCCESS! Response: ${data}`);
                        resolve(data);
                    });
                });
                httpsReq.on('error', e => reject(e));
                httpsReq.end();
            } else {
                reject(new Error(`Status ${res.statusCode}`));
            }
        });

        req.on('error', (e) => {
            console.log(`  ❌ Error: ${e.message}`);
            reject(e);
        });

        req.end();
    });
}

// Method 3: HTTP proxy (not CONNECT)
function testMethod3() {
    return new Promise((resolve, reject) => {
        console.log('\n[Method 3] Testing HTTP proxy GET...');

        const auth = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');

        const req = http.request({
            host: PROXY_HOST,
            port: PROXY_PORT,
            method: 'GET',
            path: 'http://api.ipify.org/?format=json',
            headers: {
                'Proxy-Authorization': `Basic ${auth}`,
                'Host': 'api.ipify.org'
            },
            timeout: 15000
        });

        req.on('response', (res) => {
            console.log(`  Status: ${res.statusCode}`);
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`  ✅ SUCCESS! Response: ${data}`);
                    resolve(data);
                } else {
                    console.log(`  ❌ Failed: ${data}`);
                    reject(new Error(`Status ${res.statusCode}`));
                }
            });
        });

        req.on('error', (e) => {
            console.log(`  ❌ Error: ${e.message}`);
            reject(e);
        });

        req.end();
    });
}

async function runTests() {
    try {
        await testMethod1();
    } catch (e) {
        console.log('Method 1 failed, trying Method 2...');
        try {
            await testMethod2();
        } catch (e2) {
            console.log('Method 2 failed, trying Method 3...');
            try {
                await testMethod3();
            } catch (e3) {
                console.log('\n❌ ALL METHODS FAILED');
                console.log('\nPossible issues:');
                console.log('1. Check if proxy credentials are correct');
                console.log('2. The + in password might need URL encoding');
                console.log('3. Proxy might require different auth format');
            }
        }
    }
}

runTests();
