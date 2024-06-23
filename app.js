require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const vhost = require('vhost');
const bodyParser = require('body-parser');
const compression = require('compression');
const mysql = require('mysql2');
const fs = require('fs');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const SecretKey = process.env.WEBHOOK_SECRET;

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.use(compression());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use((req, res, next) => {
    if (req.url !== '/v2/api/webhook') {
        return res.redirect(301, 'https://pages.razorpay.com/ManaMinecraft-Coins');
    }
    next();
});

app.get('/', (req, res) => {
    res.redirect('https://pages.razorpay.com/ManaMinecraft-Coins');
});
/*
function validateWebhookSignature(payload, signature, secret) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const generatedSignature = hmac.digest('hex');
    return signature === generatedSignature;
}*/

const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function queryDatabase(query, values) {
    const promisePool = pool.promise();
    try {
        const [results, fields] = await promisePool.query(query, values);
        return results;
    } catch (error) {
        console.error('Database query error:', error);
        throw error;
    }
}

app.post('/v2/api/webhook', async (req, res) => {
    try {
        console.log('Received webhook request:', req.body);
		console.log('UserName', req.body.payload.payment.entity.notes.minecraft_username);

        const log1 = JSON.stringify(req.body);
        const query2 = 'INSERT INTO razorpay_webhook_logs_raw (log) VALUES (?)';
        await queryDatabase(query2, [log1]);

        const eventPayload = req.body;
        const { entity, account_id, event, contains, payload } = eventPayload;
        const paymentEntity = payload.payment.entity;
        const { id, amount, currency, status, order_id } = paymentEntity;

        const insertLogQuery = `
            INSERT INTO razorpay_webhook_logs (
                entity,
                account_id,
                event,
                contains,
                payment_id,
                amount,
                currency,
                status,
                order_id,
                username,
                minecraft_edition,
                email,
                phone,
                method,
                card_id,
                bank,
                wallet,
                vpa
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const logValues = [
            entity,
            account_id,
            event,
            contains.join(','),
            id,
            (amount / 100),
            currency,
            status,
            order_id,
            paymentEntity.notes.minecraft_username,
            paymentEntity.notes.minecraft_edition,
            paymentEntity.email,
            paymentEntity.contact,
            paymentEntity.method,
            paymentEntity.card_id,
            paymentEntity.bank,
            paymentEntity.wallet,
            paymentEntity.vpa
        ];

        await queryDatabase(insertLogQuery, logValues);

        if (event === 'payment.captured' && status === 'captured') {
            const minecraftEdition = paymentEntity.notes.minecraft_edition;
            let username = paymentEntity.notes.minecraft_username;
			usernamedot=username;
            // Update username based on Minecraft edition
            if (minecraftEdition === 'Bedrock Edition' || minecraftEdition === 'Pocket Edition') {
                usernamedot = '.' + username;
            }
			released=1;
			if ( status === 'captured' ) { capturedstats=1; }

            // Convert amount to coins (1 Rupee = 10 coins)
            const coinsToAdd = (amount * 10) / 100;

            // Fetch the current currencyData for the user
            const selectQuery = 'SELECT currencyData FROM coinsengine_users WHERE BINARY name = ?';
            const selectResult = await queryDatabase(selectQuery, [usernamedot]);
			released=1;
            if (selectResult.length === 0) {
                console.error('Username not found:', usernamedot);
				released=0;

                // Insert into pending_coins_release_unknown_users table
                const insertPendingQuery = `
                    INSERT INTO pending_coins_release_unknown_users
                    (username, coins, amount_paid, captured, order_id, account_id, released)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `;
                await queryDatabase(insertPendingQuery, [usernamedot, coinsToAdd, (amount / 100), capturedstats, order_id, account_id, released]);

                return res.status(200).send('Username not found, logged in pending coins release');
            }

            let currentCurrencyData = selectResult[0].currencyData;
            currentCurrencyData = JSON.parse(currentCurrencyData);

            const currentBalance = currentCurrencyData.find(currency => currency.currencyId === 'coins').balance;
            const newBalance = currentBalance + coinsToAdd;

            const updateQuery = 'UPDATE coinsengine_users SET currencyData = ? WHERE BINARY name = ?';
            const updatedCurrencyData = currentCurrencyData.map(currency => {
                if (currency.currencyId === 'coins') {
                    currency.balance = newBalance;
                }
                return currency;
            });

            await queryDatabase(updateQuery, [JSON.stringify(updatedCurrencyData), usernamedot]);

            console.log('Coins Added:', coinsToAdd);
            res.status(200).send('Coins added');
        } else {
            console.log('Ignoring webhook event:', event);
            res.status(200).send('Event ignored');
        }
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Internal Server Error');
    }
});

const httpsOptions = {
    key: fs.readFileSync('payments.playedge.co.in.key'),
    cert: fs.readFileSync('payments.playedge.co.in.crt'),
    ca: fs.readFileSync('payments.playedge.co.in.csr'),
};

https.createServer(httpsOptions, app).listen(23333, () => {
    console.log('HTTPS Server running at https://payments.playedge.co.in');
});

http.createServer(app).listen(23334, () => {
    console.log('HTTP Server running at http://payments.playedge.co.in');
});
