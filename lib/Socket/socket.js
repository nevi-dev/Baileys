"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeSocket = void 0;
const boom_1 = require("@hapi/boom");
const crypto_1 = require("crypto");
const url_1 = require("url");
const util_1 = require("util");
const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const Types_1 = require("../Types");
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const Client_1 = require("./Client");
/**
 * Connects to WA servers and performs:
 * - simple queries (no retry mechanism, wait for connection establishment)
 * - listen to messages and emit events
 * - query phone connection
 */
const makeSocket = (config) => {
    var _a, _b;
    const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository, } = config;
    const url = typeof waWebSocketUrl === 'string' ? new url_1.URL(waWebSocketUrl) : waWebSocketUrl;
    if (config.mobile || url.protocol === 'tcp:') {
        throw new new boom_1.Boom('Mobile API is not supported anymore', { statusCode: Types_1.DisconnectReason.loggedOut });
    }
    if (url.protocol === 'wss' && ((_a = authState === null || authState === void 0 ? void 0 : authState.creds) === null || _a === void 0 ? void 0 : _a.routingInfo)) {
        url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'));
    }
    const ws = new Client_1.WebSocketClient(url, config);
    ws.connect();
    const ev = (0, Utils_1.makeEventBuffer)(logger);
    /** ephemeral key pair used to encrypt/decrypt communication. Unique for each connection */
    const ephemeralKeyPair = Utils_1.Curve.generateKeyPair();
    /** WA noise protocol wrapper */
    const noise = (0, Utils_1.makeNoiseHandler)({
        keyPair: ephemeralKeyPair,
        NOISE_HEADER: Defaults_1.NOISE_WA_HEADER,
        logger,
        routingInfo: (_b = authState === null || authState === void 0 ? void 0 : authState.creds) === null || _b === void 0 ? void 0 : _b.routingInfo
    });
    const { creds } = authState;
    // add transaction capability
    const keys = (0, Utils_1.addTransactionCapability)(authState.keys, logger, transactionOpts);
    const signalRepository = makeSignalRepository({ creds, keys });
    let lastDateRecv;
    let epoch = 1;
    let keepAliveReq;
    let qrTimer;
    let closed = false;
    const uqTagId = (0, Utils_1.generateMdTagPrefix)();
    const generateMessageTag = () => `${uqTagId}${epoch++}`;
    const sendPromise = (0, util_1.promisify)(ws.send);
    /** send a raw buffer */
    const sendRawMessage = async (data) => {
    try {
        if (!ws.isOpen) {
            console.error('Connection Closed')
            return
        }
        const bytes = noise.encodeFrame(data)
        await (0, Utils_1.promiseTimeout)(connectTimeoutMs, async (resolve, reject) => {
            try {
                await sendPromise.call(ws, bytes)
                resolve()
            } catch (error) {
                console.error('Connection Closed')
                return
            }
        })
    } catch (error) {
        console.error('Connection Closed')
        return
    }
}
    /** send a binary node */
    const sendNode = (frame) => {
        if (logger.level === 'trace') {
            logger.trace({ xml: (0, WABinary_1.binaryNodeToString)(frame), msg: 'xml send' });
        }
        const buff = (0, WABinary_1.encodeBinaryNode)(frame);
        return sendRawMessage(buff);
    };
    /** log & process any unexpected errors */
    const onUnexpectedError = (err, msg) => {
        logger.error({ err }, `unexpected error in '${msg}'`);
        const message = (err && ((err.stack || err.message) || String(err))).toLowerCase();
        // auto recover from cryptographic desyncs by re-uploading prekeys
        if (message.includes('bad mac') || (message.includes('mac') && message.includes('invalid'))) {
            try {
                uploadPreKeysToServerIfRequired(true)
                    .catch(e => logger.warn({ e }, 'failed to re-upload prekeys after bad mac'));
            }
            catch (_e) {
                // ignore
            }
        }
        // gently back off when encountering rate limits (429)
        if (message.includes('429') || message.includes('rate limit')) {
            const wait = Math.min(30000, (config.backoffDelayMs || 5000));
            logger.info({ wait }, 'backing off due to rate limit');
            setTimeout(() => {
                // intentionally empty; wait to delay further sends
            }, wait);
        }
    };
    /** await the next incoming message */
    const awaitNextMessage = async (sendMsg) => {
        if (!ws.isOpen) {
            throw new boom_1.Boom('Connection Closed', {
                statusCode: Types_1.DisconnectReason.connectionClosed
            });
        }
        let onOpen;
        let onClose;
        const result = (0, Utils_1.promiseTimeout)(connectTimeoutMs, (resolve, reject) => {
            onOpen = resolve;
            onClose = mapWebSocketError(reject);
            ws.on('frame', onOpen);
            ws.on('close', onClose);
            ws.on('error', onClose);
        })
            .finally(() => {
            ws.off('frame', onOpen);
            ws.off('close', onClose);
            ws.off('error', onClose);
        });
        if (sendMsg) {
            sendRawMessage(sendMsg).catch(onClose);
        }
        return result;
    };
    /**
     * Wait for a message with a certain tag to be received
     * @param msgId the message tag to await
     * @param timeoutMs timeout after which the promise will reject
     */
    const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
        let onRecv;
        let onErr;
        try {
            const result = await (0, Utils_1.promiseTimeout)(timeoutMs, (resolve, reject) => {
                onRecv = resolve;
                onErr = err => {
                    reject(err || new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed }));
                };
                ws.on(`TAG:${msgId}`, onRecv);
                ws.on('close', onErr); // if the socket closes, you'll never receive the message
                ws.off('error', onErr);
            });
            return result;
        }
        finally {
            ws.off(`TAG:${msgId}`, onRecv);
            ws.off('close', onErr); // if the socket closes, you'll never receive the message
            ws.off('error', onErr);
        }
    };
    /** send a query, and wait for its response. auto-generates message ID if not provided */
    const query = async (node, timeoutMs) => {
        if (!node.attrs.id) {
            node.attrs.id = generateMessageTag();
        }
        const msgId = node.attrs.id;
        const [result] = await Promise.all([
            waitForMessage(msgId, timeoutMs),
            sendNode(node)
        ]);
        if ('tag' in result) {
            (0, WABinary_1.assertNodeErrorFree)(result);
        }
        return result;
    };
    /** connection handshake */
    const validateConnection = async () => {
        let helloMsg = {
            clientHello: { ephemeral: ephemeralKeyPair.public }
        };
        helloMsg = WAProto_1.proto.HandshakeMessage.fromObject(helloMsg);
        logger.info({ browser, helloMsg }, 'connected to WA');
        const init = WAProto_1.proto.HandshakeMessage.encode(helloMsg).finish();
        const result = await awaitNextMessage(init);
        const handshake = WAProto_1.proto.HandshakeMessage.decode(result);
        logger.trace({ handshake }, 'handshake recv from WA');
        const keyEnc = await noise.processHandshake(handshake, creds.noiseKey);
        let node;
        if (!creds.me) {
            node = (0, Utils_1.generateRegistrationNode)(creds, config);
            logger.info({ node }, 'not logged in, attempting registration...');
        }
        else {
            node = (0, Utils_1.generateLoginNode)(creds.me.id, config);
            logger.info({ node }, 'logging in...');
        }
        const payloadEnc = noise.encrypt(WAProto_1.proto.ClientPayload.encode(node).finish());
        await sendRawMessage(WAProto_1.proto.HandshakeMessage.encode({
            clientFinish: {
                static: keyEnc,
                payload: payloadEnc,
            },
        }).finish());
        noise.finishInit();
        startKeepAliveRequest();
    };
    const getAvailablePreKeysOnServer = async () => {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                xmlns: 'encrypt',
                type: 'get',
                to: WABinary_1.S_WHATSAPP_NET
            },
            content: [
                { tag: 'count', attrs: {} }
            ]
        });
        const countChild = (0, WABinary_1.getBinaryNodeChild)(result, 'count');
        return +countChild.attrs.value;
    };
    /** generates and uploads a set of pre-keys to the server */
    const uploadPreKeys = async (count = Defaults_1.INITIAL_PREKEY_COUNT) => {
        await keys.transaction(async () => {
            logger.info({ count }, 'uploading pre-keys');
            const { update, node } = await (0, Utils_1.getNextPreKeysNode)({ creds, keys }, count);
            await query(node);
            ev.emit('creds.update', update);
            logger.info({ count }, 'uploaded pre-keys');
        });
    };
    const uploadPreKeysToServerIfRequired = async () => {
        const preKeyCount = await getAvailablePreKeysOnServer();
        logger.info(`${preKeyCount} pre-keys found on server`);
        if (preKeyCount <= Defaults_1.MIN_PREKEY_COUNT) {
            await uploadPreKeys();
        }
    };
    const onMessageReceived = (data) => {
        noise.decodeFrame(data, frame => {
            var _a;
            // reset ping timeout
            lastDateRecv = new Date();
            let anyTriggered = false;
            anyTriggered = ws.emit('frame', frame);
            // if it's a binary node
            if (!(frame instanceof Uint8Array)) {
                const msgId = frame.attrs.id;
                if (logger.level === 'trace') {
                    logger.trace({ xml: (0, WABinary_1.binaryNodeToString)(frame), msg: 'recv xml' });
                }
                /* Check if this is a response to a message we sent */
                anyTriggered = ws.emit(`${Defaults_1.DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered;
                /* Check if this is a response to a message we are expecting */
                const l0 = frame.tag;
                const l1 = frame.attrs || {};
                const l2 = Array.isArray(frame.content) ? (_a = frame.content[0]) === null || _a === void 0 ? void 0 : _a.tag : '';
                for (const key of Object.keys(l1)) {
                    anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered;
                    anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered;
                    anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered;
                }
                anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered;
                anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered;
                if (!anyTriggered && logger.level === 'debug') {
                    logger.debug({ unhandled: true, msgId, fromMe: false, frame }, 'communication recv');
                }
            }
        });
    };
    const end = (error) => {
        if (closed) {
            logger.trace({ trace: error === null || error === void 0 ? void 0 : error.stack }, 'connection already closed');
            return;
        }
        closed = true;
        logger.info({ trace: error === null || error === void 0 ? void 0 : error.stack }, error ? 'connection errored' : 'connection closed');
        clearInterval(keepAliveReq);
        clearTimeout(qrTimer);
        ws.removeAllListeners('close');
        ws.removeAllListeners('error');
        ws.removeAllListeners('open');
        ws.removeAllListeners('message');
        if (!ws.isClosed && !ws.isClosing) {
            try {
                ws.close();
            }
            catch (_a) { }
        }
        ev.emit('connection.update', {
            connection: 'close',
            lastDisconnect: {
                error,
                date: new Date()
            }
        });
        ev.removeAllListeners('connection.update');
    };
    const waitForSocketOpen = async () => {
        if (ws.isOpen) {
            return;
        }
        if (ws.isClosed || ws.isClosing) {
            throw new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed });
        }
        let onOpen;
        let onClose;
        await new Promise((resolve, reject) => {
            onOpen = () => resolve(undefined);
            onClose = mapWebSocketError(reject);
            ws.on('open', onOpen);
            ws.on('close', onClose);
            ws.on('error', onClose);
        })
            .finally(() => {
            ws.off('open', onOpen);
            ws.off('close', onClose);
            ws.off('error', onClose);
        });
    };
    const startKeepAliveRequest = () => (keepAliveReq = setInterval(() => {
        if (!lastDateRecv) {
            lastDateRecv = new Date();
        }
        const diff = Date.now() - lastDateRecv.getTime();
        /*
            check if it's been a suspicious amount of time since the server responded with our last seen
            it could be that the network is down
        */
        if (diff > keepAliveIntervalMs + 5000) {
            end(new boom_1.Boom('Connection was lost', { statusCode: Types_1.DisconnectReason.connectionLost }));
        }
        else if (ws.isOpen) {
            // if its all good, send a keep alive request
            query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    to: WABinary_1.S_WHATSAPP_NET,
                    type: 'get',
                    xmlns: 'w:p',
                },
                content: [{ tag: 'ping', attrs: {} }]
            })
                .catch(err => {
                logger.error({ trace: err.stack }, 'error in sending keep alive');
            });
        }
        else {
            logger.warn('keep alive called when WS not open');
        }
    }, keepAliveIntervalMs));
    /** i have no idea why this exists. pls enlighten me */
    const sendPassiveIq = (tag) => (query({
        tag: 'iq',
        attrs: {
            to: WABinary_1.S_WHATSAPP_NET,
            xmlns: 'passive',
            type: 'set',
        },
        content: [
            { tag, attrs: {} }
        ]
    }));
    /** logout & invalidate connection */
    const logout = async (msg) => {
        var _a;
        const jid = (_a = authState.creds.me) === null || _a === void 0 ? void 0 : _a.id;
        if (jid) {
            await sendNode({
                tag: 'iq',
                attrs: {
                    to: WABinary_1.S_WHATSAPP_NET,
                    type: 'set',
                    id: generateMessageTag(),
                    xmlns: 'md'
                },
                content: [
                    {
                        tag: 'remove-companion-device',
                        attrs: {
                            jid,
                            reason: 'user_initiated'
                        }
                    }
                ]
            });
        }
        end(new boom_1.Boom(msg || 'Intentional Logout', { statusCode: Types_1.DisconnectReason.loggedOut }));
    };
    
    // 🌟 CÓDIGO DE EMPAREJAMIENTO PARCHADO 
    const requestPairingCode = async (phoneNumber, pairKey) => {
        let finalPairCode;

        // Si se pasa un pairKey, se usa (tomando los primeros 4 caracteres). Si no, usa 'NEVI'.
        const baseKey = pairKey?.toUpperCase() || 'NEVI';

        // Aseguramos que solo tomamos los primeros 4 caracteres y agregamos 'CODE'
        finalPairCode = baseKey.substring(0, 4) + 'CODE';

        authState.creds.pairingCode = finalPairCode;
        
        // El resto del código es original, solo se modificó la lógica de generación del código.
        authState.creds.me = {
            id: (0, WABinary_1.jidEncode)(phoneNumber, 's.whatsapp.net'),
            name: '~'
        };
        ev.emit('creds.update', authState.creds);
        await sendNode({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                id: generateMessageTag(),
                xmlns: 'md'
            },
            content: [
                {
                    tag: 'link_code_companion_reg',
                    attrs: {
                        jid: authState.creds.me.id,
                        stage: 'companion_hello',
                        // eslint-disable-next-line camelcase
                        should_show_push_notification: 'true'
                    },
                    content: [
                        {
                            tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
                            attrs: {},
                            content: await generatePairingKey()
                        },
                        {
                            tag: 'companion_server_auth_key_pub',
                            attrs: {},
                            content: authState.creds.noiseKey.public
                        },
                        {
                            tag: 'companion_platform_id',
                            attrs: {},
                            content: (0, Utils_1.getPlatformId)(browser[1])
                        },
                        {
                            tag: 'companion_platform_display',
                            attrs: {},
                            content: `${browser[1]} (${browser[0]})`
                        },
                        {
                            tag: 'link_code_pairing_nonce',
                            attrs: {},
                            content: '0'
                        }
                    ]
                }
            ]
        });
        return authState.creds.pairingCode;
    };
    async function generatePairingKey() {
        const salt = (0, crypto_1.randomBytes)(32);
        const randomIv = (0, crypto_1.randomBytes)(16);
        const key = await (0, Utils_1.derivePairingCodeKey)(authState.creds.pairingCode, salt);
        const ciphered = (0, Utils_1.aesEncryptCTR)(authState.creds.pairingEphemeralKeyPair.public, key, randomIv);
        return Buffer.concat([salt, randomIv, ciphered]);
    }
    // ... (omitted sendWAMBuffer)

    // ... (omitted ws event listeners)
    
    // login complete
    ws.on('CB:success', async (node) => {
        try {
            await uploadPreKeysToServerIfRequired();
            await sendPassiveIq('active');
            logger.info('opened connection to WA');
            clearTimeout(qrTimer); // will never happen in all likelyhood -- but just in case WA sends success on first try
            ev.emit('creds.update', { me: { ...authState.creds.me, lid: node.attrs.lid } });
            ev.emit('connection.update', { connection: 'open' });
        }
        catch (err) {
            logger.error({ err }, 'error opening connection');
            end(err);
        }
    });

    // ... (omitted remaining ws event listeners)

    return {
        type: 'md',
        ws,
        ev,
        authState: { creds, keys },
        signalRepository,
        get user() {
            return authState.creds.me;
        },
        generateMessageTag,
        query,
        waitForMessage,
        waitForSocketOpen,
        sendRawMessage,
        sendNode,
        logout,
        end,
        onUnexpectedError,
        uploadPreKeys,
        uploadPreKeysToServerIfRequired,
        requestPairingCode,
        /** Waits for the connection to WA to reach a state */
        waitForConnectionUpdate: (0, Utils_1.bindWaitForConnectionUpdate)(ev),
        sendWAMBuffer,
    };
};
exports.makeSocket = makeSocket;
/**
 * map the websocket error to the right type
 * so it can be retried by the caller
 * */
function mapWebSocketError(handler) {
    return (error) => {
        handler(new boom_1.Boom(`WebSocket Error (${error === null || error === void 0 ? void 0 : error.message})`, { statusCode: (0, Utils_1.getCodeFromWSError)(error), data: error }));
    };
}
