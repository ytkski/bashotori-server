'use strict'
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const compression = require('compression')
const app = express()

const linePay = require('./line-pay');
const pay = new linePay({
    channelId: process.env.LINE_PAY_CHANNEL_ID,
    channelSecret: process.env.LINE_PAY_CHANNEL_SECRET,
    isSandbox: true
});

// Importing LINE Messaging API SDK
const lineBot = require('@line/bot-sdk');
const botConfig = {
    channelAccessToken: process.env.LINE_BOT_ACCESS_TOKEN,
    channelSecret: process.env.LINE_BOT_CHANNEL_SECRET
}
const bot = new lineBot.Client(botConfig);
const redis = require('redis');
var redisClient;
if (process.env.REDIS_URL) {
    const url = require('url').parse(process.env.REDIS_URL);
    redisClient = redis.createClient(url.port, url.hostname);
    redisClient.auth(url.auth.split(":")[1]);
} else {
    redisClient = redis.createClient();
}

const placeIdMap = {
    place1: {
        name: "アキバ・スクエア",
        price: 500
    },
    place2: {
        name: "川崎市産業振興会館 1Fホール",
        price: 300
    }
}

const TRANSACTION_KEY_PREFIX = 'transaction';
const RESERVATION_KEY_PREFIX = 'reservation';
const USER_KEY_PREFIX = 'user';
const PLACE_KEY_PREFIX = 'place';
const RESERVATIONS_KEY_SUFFIX = "reservations";

app.use(compression())
app.use(cors())
// Only use bodyParser for reserve API to avoid conflict with original parser used by LINE SDK Middleware.
app.use('/reservations', bodyParser.json())
app.use('/reservations', bodyParser.urlencoded({ extended: true }))

app.listen(process.env.PORT || 3000, function () {
    console.log("Express server listening on port %d in %s mode", this.address().port, app.settings.env);
});

/*
* API to receive webhook from LINE server
*/
app.post('/webhook', lineBot.middleware(botConfig), (req, res) => {
    res.sendStatus(200);

    req.body.events.map((event) => {
        // We skip connection validation message.
        if (event.replyToken == "00000000000000000000000000000000"
            || event.replyToken == "ffffffffffffffffffffffffffffffff") return;
        if (event.type == 'message') {
            let message = {
                type: 'text'
            };
            if (event.message.text.startsWith('liff:')) {
                const placeId = event.message.text.slice(5);
                if (placeIdMap[placeId]) {
                    message.text = `こちらから${placeIdMap[placeId].name}の予約ができます。\nline://app/1583493860-veQMonpA?placeId=${event.message.text.slice(5)}`;
                } else {
                    message.text = '不正な場所IDです。';
                }
            } else if (event.message.text.startsWith('予約')) {
                message.text = `こちらから予約の確認とキャンセルができます。\nline://app/1583493860-84bo0z34`;
            } else {
                message.text = 'すみません、わかりませんでした。';
            }
            return bot.replyMessage(event.replyToken, message).then((response) => {
                console.log(response);
            }).catch((err) => {
                console.log(err);
            });
        };
    });
});


app.post("/reservations", (req, res) => {
    console.log("body: " + req.body);
    if (!req.body.userId) {
        return res.status(400).send({ "result": "error", "message": "User id not found." });
    }
    console.log("productInfo: " + req.body.productInfo);
    _reserve(req.body.userId, req.body.productInfo)
        .then((data) => {
            res.status(200).send({ "result": "success", "uri": data.uri });
        }).catch((err) => {
            res.status(400).send({ "result": "error", "message": "Reservation failed." });
        });
})

/*
* If user approves the payment, LINE Pay server call this webhook.
*/
app.get("/pay/confirm", (req, res) => {
    const transactionId = req.query.transactionId;
    if (!transactionId) {
        console.log("Error: Transaction ID not found.");
        return res.status(400).send("Transaction ID not found.");
    }
    // Retrieve the transaction from database.
    redisClient.hgetall(TRANSACTION_KEY_PREFIX + ":" + transactionId, (err, transaction) => {
        if (err || !transaction) {
            console.log("Error: Transaction not found.");
            return res.status(500).send({ "result": "error", "message": "Internal error occurred." });
        }
        console.log('Retrieved transaction: ' + transaction);
        const reservationId = transactionId;
        const deserializedProductInfo = JSON.parse(transaction.productInfo);
        const userKey = USER_KEY_PREFIX + ":" + transaction.userId + ":" + RESERVATIONS_KEY_SUFFIX;
        const placeKey = PLACE_KEY_PREFIX + ":" + deserializedProductInfo.placeId + ":" + RESERVATIONS_KEY_SUFFIX;
        let reservation = {
            reservedBy: transaction.userId,
            productInfo: transaction.productInfo // Keep serialized data
        }
        redisClient.watch(userKey, placeKey, (err) => {
            // TODO: check whether there is exsiting reservation whose product is the same as request.
            redisClient.multi()
                .hmset(RESERVATION_KEY_PREFIX + ":" + reservationId, reservation, () => {
                    console.log('Reservation stored: ' + reservationId + ": " + JSON.stringify(reservation));
                })
                .sadd(userKey, reservationId)
                .sadd(placeKey, reservationId)
                .del(`${TRANSACTION_KEY_PREFIX}:${transactionId}`)
                .exec((err, replies) => {
                    if (err) {
                        console.log("Persistence error: " + err.errors);
                        res.status(500).send({ "result": "error", "message": "Internal error occurred." });
                        return _pushInternalErrorMessage(transaction.userId);
                    } else {
                        replies.forEach((reply, i) => {
                            console.log(`Reservation executed: ${reply}`);
                        })
                        let confirmation = {
                            transactionId: transactionId,
                            amount: transaction.amount,
                            currency: transaction.currency
                        }
                        return pay.confirm(confirmation).then((response) => {
                            console.log(response);
                            res.sendStatus(200);
                            let messages = [{
                                type: "sticker",
                                packageId: 2,
                                stickerId: 144
                            }, {
                                type: "text",
                                text: `おめでとうございます！ ${transaction.productName} を予約しました。`
                            }]
                            return bot.pushMessage(transaction.userId, messages);
                        }).catch((err) => {
                            console.log(err);
                            res.sendStatus(400);
                            return _pushInternalErrorMessage(transaction.userId);
                        });
                    }
                });
        });
    });
})

app.get('/places/:placeId', (req, res) => {
    res.send(placeIdMap[req.params.placeId]);
});

/**
 * date: yyyyMMdd
 */
app.get('/places/:placeId/availableTimes/:date', (req, res) => {
    _getAvailableTimes(req.params.placeId, req.params.date)
        .then((availableTimes) => {
            const response = {
                'availableTimes': availableTimes
            }
            res.status(200).send(response);
        }).catch((err) => {
            res.status(500).send({ "result": "error", "message": "Internal error occurred." });
        });
});

app.get('/users/:userId/reservations', (req, res) => {
    if (!req.params.userId) {
        console.log("User ID is not specified.");
        res.status(400).send({ "result": "error", "message": "Request is invalid." });
    }
    _getUserReservations(req.params.userId, req.query.placeId)
        .then((reservations) => {
            const response = {
                'reservations': reservations
            }
            res.status(200).send(response);
        }).catch((err) => {
            console.log(err);
            res.status(500).send({ "result": "error", "message": "Internal error occurred." });
        });
});

app.delete('/users/:userId/reservations/:reservationId', (req, res) => {
    if (!req.params.userId || !req.params.reservationId) {
        console.log("User ID or reservation ID is not specified.");
        res.status(400).send({ "result": "error", "message": "Request is invalid." });
    }
    _deleteUserReservation(req.params.userId, req.params.reservationId)
        .then(() => {
            res.sendStatus(200);
        }).catch((err) => {
            console.log(err);
            res.status(500).send({ "result": "error", "message": "Internal error occurred." });
        })
})

function _getAvailableTimes(placeId, date) {
    // TODO filtering periods of the day
    const periods = ['10:00-12:00', '12:00-14:00', '14:00-16:00', '16:00-18:00', '18:00-20:00'];
    return new Promise((resolve, reject) => {
        redisClient.smembers(PLACE_KEY_PREFIX + ":" + placeId + ":" + RESERVATIONS_KEY_SUFFIX, (err, reservationIds) => {
            if (err) {
                reject(err);
            }
            if (reservationIds.length == 0) {
                console.log("No reservation for " + placeId);
                resolve(periods);
            }
            var promises = [];
            reservationIds.forEach((reservationId) => {
                promises.push(new Promise((resolve, reject) => {
                    redisClient.hgetall(RESERVATION_KEY_PREFIX + ":" + reservationId, (err, reservation) => {
                        if (err) { reject(err); }
                        console.log("Reserved time: " + reservation['productInfo']);
                        const reservedProductInfo = JSON.parse(reservation['productInfo']);
                        if (date == _getFormattedReservedDate(reservedProductInfo)) {
                            resolve(reservedProductInfo.time);
                        } else {
                            resolve();
                        }
                    });
                }));
            });
            Promise.all(promises)
                .then((reserved) => {
                    console.log("Reserved time for " + placeId + ": " + reserved);
                    if (reserved.length == 0) {
                        resolve(periods);
                    }
                    var result = [];
                    periods.forEach(period => {
                        if (!reserved.includes(period)) {
                            result.push(period);
                        }
                    });
                    resolve(result);
                }).catch((err) => {
                    reject(err);
                });
        });
    });
}

function _getFormattedReservedDate(productInfo) {
    return productInfo.year + ("0" + (productInfo.month)).slice(-2) + ("0" + (productInfo.day)).slice(-2);
}

function _getUserReservations(userId, placeId) {
    return new Promise((resolve, reject) => {
        redisClient.smembers(USER_KEY_PREFIX + ":" + userId + ":" + RESERVATIONS_KEY_SUFFIX, (err, reservationIds) => {
            if (err) {
                reject(err);
            }
            if (reservationIds.length == 0) {
                console.log("No reservation for " + userId);
                resolve([]);
            }
            var promises = [];
            const today = new Date();
            reservationIds.forEach((reservationId) => {
                promises.push(new Promise((resolve, reject) => {
                    redisClient.hgetall(RESERVATION_KEY_PREFIX + ":" + reservationId, (err, reservation) => {
                        if (err) { reject(err); }
                        console.log("Reserved time: " + reservation['productInfo']);
                        const reservedProductInfo = JSON.parse(reservation['productInfo']);
                        if (placeId && placeId != reservedProductInfo.placeId) {
                            resolve();
                        }
                        if (_isAvailableReservation(today, reservedProductInfo)) {
                            const result = {
                                reservationId: reservationId,
                                productInfo: reservedProductInfo
                            }
                            resolve(result);
                        } else {
                            resolve();
                        }
                    });
                }));
            });
            Promise.all(promises)
                .then((reserved) => {
                    console.log("Reserved info for " + userId + ": " + reserved);
                    resolve(reserved.filter(Boolean)); // Remove null values
                })
                .catch((err) => {
                    reject(err);
                });
        });
    });
}

function _isAvailableReservation(today, productInfo) {
    const reservedUntil = productInfo.time.split('-')[1].split(':');
    const reservedDate = new Date(productInfo.year, productInfo.month - 1, productInfo.day, reservedUntil[0], reservedUntil[1]);
    // TODO considering timezone
    return today.getTime() <= reservedDate.getTime();
}

function _reserve(userId, productInfo) {
    console.log('User approved to pay.');
    // TODO Get place ID from Context in DB
    var placeInfo = placeIdMap[productInfo.placeId];
    if (!placeInfo) {
        console.log("placeId " + productInfo.placeId + " is unknown.");
        // TODO error
    }
    productInfo.placeName = placeInfo.name;
    let transaction = {
        productName: productInfo.name,
        amount: productInfo.price,
        currency: 'JPY',
        confirmUrl: process.env.LINE_PAY_CONFIRM_URL,
        confirmUrlType: 'SERVER',
        orderId: `${userId}-${Date.now()}`
    }

    // Call LINE Pay reserve API
    return new Promise((resolve, reject) => {
        _checkTransaction(productInfo)
            .then(() => {
                pay.reserve(transaction)
                    .then((response) => {
                        console.log('LINE Pay reserve response: ' + response);
                        // TODO: Transaction ID in LINE Pay response is timestamp in millisec, which might be duplicated.
                        const transactionId = response.info.transactionId;
                        transaction.userId = userId;
                        transaction.type = 'reserve';
                        // Need to stringify to store in redis if there is object value in transaction items.
                        transaction.productInfo = JSON.stringify(productInfo);
                        const key = TRANSACTION_KEY_PREFIX + ":" + transactionId;
                        redisClient.multi()
                            .hmset(key, transaction, (err, res) => {
                                console.log("Redis response: " + res);
                                console.log('Transaction stored: ' + transactionId + ": " + JSON.stringify(transaction));
                            })
                            .expire(key, 600)
                            .exec((err, replies) => {
                                if (err) {
                                    console.log("Persistence error: " + err.errors);
                                    reject(err.errors);;
                                } else {
                                    replies.forEach((reply, i) => {
                                        console.log(`Transaction executed: ${reply}`);
                                    })
                                    resolve({ uri: response.info.paymentUrl.web });
                                }
                            });
                    })
                    .catch((err) => {
                        console.log('Error occurred: ' + err);
                        reject(err);
                    });
            }).catch(err => {
                reject(err);
            });
    });
}

function _checkTransaction(productInfo) {
    return new Promise((resolve, reject) => {
        // TODO: check whether there is existing transaction or reservation whose product is the same as request.
        resolve();
    });
}

function _pushInternalErrorMessage(userId) {
    let messages = [{
        type: "sticker",
        packageId: 2,
        stickerId: 38
    }, {
        type: "text",
        text: "申し訳ありません。不明なエラーが発生しました。"
    }];
    return bot.pushMessage(userId, messages);
}

function _deleteUserReservation(userId, reservationId) {
    const reservationKey = `${RESERVATION_KEY_PREFIX}:${reservationId}`;
    return new Promise((resolve, reject) => {
        redisClient.hgetall(reservationKey, (err, reservation) => {
            if (err) reject(err);
            if (!reservation) resolve();
            if (reservation.reservedBy != userId) reject(err);
            const userKey = `${USER_KEY_PREFIX}:${userId}:${RESERVATIONS_KEY_SUFFIX}`;
            const placeKey = `${PLACE_KEY_PREFIX}:${JSON.parse(reservation.productInfo).placeId}:${RESERVATIONS_KEY_SUFFIX}`;
            redisClient.watch(reservationKey, userKey, placeKey, (err) => {
                redisClient.multi()
                    .del(reservationKey)
                    .srem(userKey, reservationId)
                    .srem(placeKey, reservationId)
                    .exec((err, replies) => {
                        if (err) {
                            reject(err)
                        } else {
                            replies.forEach((reply, i) => {
                                console.log(`Deletion executed: ${reply}`);
                            })
                            resolve();
                        }
                    });
            });
        })
    });
}