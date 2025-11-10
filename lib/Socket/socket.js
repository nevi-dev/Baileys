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

// =================================================================
// 🔑 FUNCIÓN AUXILIAR MODIFICADA PARA CÓDIGO DE EMPAREJAMIENTO
// =================================================================

/**
 * Genera un código de emparejamiento personalizado (4 caracteres + 'CODE').
 * Si el nombre es muy corto o no se proporciona, usa "NEVICODE".
 * Ejemplos: "Ellen" -> "ELLECODE", "Luffy" -> "LUFYCODE".
 */
const generateCustomPairKey = (name) => {
    // Valor predeterminado de 8 caracteres
    const DEFAULT_KEY = "NEVICODE";

    if (!name) {
        // Retorna el valor predeterminado si no se proporciona un nombre
        return DEFAULT_KEY; 
    }
    
    // Limpia el nombre (solo letras/números) y lo pone en minúsculas
    name = name.toLowerCase().replace(/[^a-z0-9]/g, ''); 
    
    if (name.length < 4) {
        // Retorna el valor predeterminado si el nombre es demasiado corto
        return DEFAULT_KEY;
    }
    
    // Genera el prefijo: toma los primeros 4 caracteres
    const prefix = name.substring(0, 4); 
    
    // Combina el prefijo con el sufijo fijo 'CODE' (8 caracteres en total)
    const key = `${prefix}CODE`; // ¡Guion Eliminado!
    
    // WhatsApp espera mayúsculas (ELLECODE)
    return key.toUpperCase();
};

// =================================================================
// 🔌 makeSocket FUNCIÓN PRINCIPAL
// =================================================================

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
        throw new boom_1.Boom('Mobile API is not supported anymore', { statusCode: Types_1.DisconnectReason.loggedOut });
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
    
    // =================================================================
    // 🚀 FUNCIÓN requestPairingCode MODIFICADA
    // =================================================================
    
    // Ahora acepta 'botName' para generar un código de emparejamiento personalizado.
    const requestPairingCode = async (phoneNumber, botName) => { 
        // Genera el código de emparejamiento personalizado o usa el valor predeterminado
        const customPairKey = generateCustomPairKey(botName);

        // Asigna el PairKey generado
        authState.creds.pairingCode = customPairKey;

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
    const sendWAMBuffer = (wamBuffer) => {
        return query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                id: generateMessageTag(),
                xmlns: 'w:stats'
            },
            content: [
                {
                    tag: 'add',
                    attrs: {},
                    content: wamBuffer
                }
            ]
        });
    };
    ws.on('message', onMessageReceived);
    ws.on('open', async () => {
        try {
            await validateConnection();
        }
        catch (err) {
            logger.error({ err }, 'error in validating connection');
            end(err);
        }
    });
    ws.on('error', mapWebSocketError(end));
    ws.on('close', () => end(new boom_1.Boom('Connection Terminated', { statusCode: Types_1.DisconnectReason.connectionClosed })));
    // the server terminated the connection
    ws.on('CB:xmlstreamend', () => end(new boom_1.Boom('Connection Terminated by Server', { statusCode: Types_1.DisconnectReason.connectionClosed })));
    // QR gen
    ws.on('CB:iq,type:set,pair-device', async (stanza) => {
        const iq = {
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'result',
                id: stanza.attrs.id,
            }
        };
        await sendNode(iq);
        const pairDeviceNode = (0, WABinary_1.getBinaryNodeChild)(stanza, 'pair-device');
        const refNodes = (0, WABinary_1.getBinaryNodeChildren)(pairDeviceNode, 'ref');
        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
        const advB64 = creds.advSecretKey;
        let qrMs = qrTimeout || 60000; // time to let a QR live
        const genPairQR = () => {
            if (!ws.isOpen) {
                return;
            }
            const refNode = refNodes.shift();
            if (!refNode) {
                end(new boom_1.Boom('QR refs attempts ended', { statusCode: Types_1.DisconnectReason.timedOut }));
                return;
            }
            const ref = refNode.content.toString('utf-8');
            const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',');
            ev.emit('connection.update', { qr });
            qrTimer = setTimeout(genPairQR, qrMs);
            qrMs = qrTimeout || 20000; // shorter subsequent qrs
        };
        genPairQR();
    });
    // device paired for the first time
    // if device pairs successfully, the server asks to restart the connection
    ws.on('CB:iq,,pair-success', async (stanza) => {
        logger.debug('pair success recv');
        try {
            const { reply, creds: updatedCreds } = (0, Utils_1.configureSuccessfulPairing)(stanza, creds);
            logger.info({ me: updatedCreds.me, platform: updatedCreds.platform }, 'pairing configured successfully, expect to restart the connection...');
            ev.emit('creds.update', updatedCreds);
            ev.emit('connection.update', { isNewLogin: true, qr: undefined });
            await sendNode(reply);
        }
        catch (error) {
            logger.info({ trace: error.stack }, 'error in pairing');
            end(error);
        }
    });
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
    ws.on('CB:stream:error', (node) => {
        logger.error({ node }, 'stream errored out');
        const { reason, statusCode } = (0, Utils_1.getErrorCodeFromStreamError)(node);
        end(new boom_1.Boom(`Stream Errored (${reason})`, { statusCode, data: node }));
    });
    // stream fail, possible logout
    ws.on('CB:failure', (node) => {
        const reason = +(node.attrs.reason || 500);
        end(new boom_1.Boom('Connection Failure', { statusCode: reason, data: node.attrs }));
    });
    ws.on('CB:ib,,downgrade_webclient', () => {
        end(new boom_1.Boom('Multi-device beta not joined', { statusCode: Types_1.DisconnectReason.multideviceMismatch }));
    });
    ws.on('CB:ib,,offline_preview', (node) => {
        logger.info('offline preview received', JSON.stringify(node));
        sendNode({
            tag: 'ib',
            attrs: {},
            content: [{ tag: 'offline_batch', attrs: { count: '100' } }]
        });
    });
    ws.on('CB:ib,,edge_routing', (node) => {
        const edgeRoutingNode = (0, WABinary_1.getBinaryNodeChild)(node, 'edge_routing');
        const routingInfo = (0, WABinary_1.getBinaryNodeChild)(edgeRoutingNode, 'routing_info');
        if (routingInfo === null || routingInfo === void 0 ? void 0 : routingInfo.content) {
            authState.creds.routingInfo = Buffer.from(routingInfo === null || routingInfo === void 0 ? void 0 : routingInfo.content);
            ev.emit('creds.update', authState.creds);
        }
    });
    let didStartBuffer = false;
    process.nextTick(() => {
        var _a;
        if ((_a = creds.me) === null || _a === void 0 ? void 0 : _a.id) {
            // start buffering important events
            // if we're logged in
            ev.buffer();
            didStartBuffer = true;
        }
        ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined });
    });
    // called when all offline notifs are handled
    ws.on('CB:ib,,offline', (node) => {
        const child = (0, WABinary_1.getBinaryNodeChild)(node, 'offline');
        const offlineNotifs = +((child === null || child === void 0 ? void 0 : child.attrs.count) || 0);
        logger.info(`handled ${offlineNotifs} offline messages/notifications`);
        if (didStartBuffer) {
            ev.flush();
            logger.trace('flushed events for initial buffer');
        }
        ev.emit('connection.update', { receivedPendingNotifications: true });
    });
    // update credentials when required
    ev.on('creds.update', update => {
        var _a, _b;
        const name = (_a = update.me) === null || _a === void 0 ? void 0 : _a.name;
        // if name has just been received
        if (((_b = creds.me) === null || _b === void 0 ? void 0 : _b.name) !== name) {
            logger.debug({ name }, 'updated pushName');
            sendNode({
                tag: 'presence',
                attrs: { name: name }
            })
                .catch(err => {
                logger.warn({ trace: err.stack }, 'error in sending presence update on name change');
            });
        }
        Object.assign(creds, update);
    });
    if (printQRInTerminal) {
        (0, Utils_1.printQRIfNecessaryListener)(ev, logger);
    }
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
