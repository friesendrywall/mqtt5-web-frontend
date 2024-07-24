/*
 MQTT5 <-> network
 */
import { v4 } from 'uuid';
import websocket from 'websocket-stream';
import mqttCon from 'mqtt-connection';
import events from 'events';

const clientEvents = new events.EventEmitter();

const DEFAULT_KEEP_ALIVE_PING_TIME = 15 * 60 * 1000;
// eslint-disable-next-line no-unused-vars
let timeoutTime = 5000;
let lastUserAction = 0;
const clientId = 'WEB-' + v4();
const EVENT = {
    TIMEOUT: 'Timeout',
    CLOSED: 'Closed',
    VALID: 'Valid'
};

// Shim for mqtt-connection
if (!window.setImmediate) {
    window.setImmediate = function (func) {
        setTimeout(func, 0);
    };
}

/**
 * @typedef connector_opt_t
 * @type {object}
 * @property {function | undefined} log_func
 * @property {string|undefined} wss_url
 *
 */

/**
 *
 * @param {connector_opt_t} options
 * @returns {{
 *  subscribe: ((function((string|string[])): Promise<{subscribed: boolean, reason: string}|{subscribed: boolean, reason: *}|boolean>)|*),
 *  publish: ((function(string, *): Promise<{reason: number, error: string, sent: boolean}|{reason: string, sent: boolean}|
 *      {reason: string, data: object, reasonCode: *, error: (string|string[]), sent: boolean}>)|*),
 *  unSubscribe: ((function((string|string[])): Promise<{subscribed: boolean, reason: string}|{subscribed: boolean, reason: *}|boolean>)|*),
 *  open: function(jwt, user_id),
 *  close: function(void),
 *  on: function('publish'|'connect'|'login'|'logged-out', function())}}
 * @constructor
 */
const Connector = function (options) {
    // Events
    let loggedIn = false;
    let onPublish = null;
    let onConnect = null;
    let onLoggedOut = null;
    // Other local variables
    let currentMessageId = 0;
    let client = null;
    let currentSession = null;

    const subscriptions = [];
    const pendingEvents = [];

    const log = function (...arg) {
        if (options && options.log_func) {
            options.log_func.apply(this, arg);
        }
    };

    const mqtt_url = options && options.wss_url ? options.wss_url : '/api/wss/mqtt';

    const getMqttError = function (err) {
        switch (err) {
            case 0:
                return 'GRANTED QOS 0';
            case 1:
                return 'GRANTED QOS 1';
            case 2:
                return 'GRANTED QOS 2';
            case 17:
                return 'NO_SUBSCRIPTION';
            case 131:
                return 'IMP_SPEC_ERROR';
            case 134:
                return 'BAD_USER_PASS';
            case 135:
                return 'NOT_AUTHORIZED';
            case 136:
                return 'SERVER_UNAVAILABLE';
            case 143:
                return 'TOPIC_INVALID';
            case 144:
                return 'WILL_TOPIC_INVALID';
            case 149:
                return 'PACKET_TOO_LARGE';
            case 153:
                return 'PAYLOAD_INVALID';
            case 155:
                return 'QOS_NOT_SUPPORTED';
            default:
                return `Unknown const (${err})`;
        }
    };

    const getNewMessageId = function () {
        if (++currentMessageId > 0xffff) {
            currentMessageId = 1;
        }
        return currentMessageId;
    };

    const openWebSocket = function (jwt, user_id) {
        let closed = false;
        let mqttKeepAliveTimer = null;
        let connTimer = null;
        const url =
            window.location.protocol.replace('http', 'ws') +
            '//' +
            window.location.host + mqtt_url;
        const ws = websocket(url);
        client = mqttCon(ws, {
            protocolVersion: 5
        });

        const closeConnection = function (reason, restart = true) {
            if (closed) {
                return;
            }
            closed = true;
            // Make sure to close anything pending
            const pendEv = Object.keys(pendingEvents);
            pendEv.forEach((key) => {
                clientEvents.emit(key, EVENT.CLOSED, null);
                delete pendingEvents[key];
            });

            try {
                clientEvents.emit('error', EVENT.CLOSED);
            } catch (error) {
                // No pending errors
            }
            log('MQTT closed:' + reason);
            clearTimeout(mqttKeepAliveTimer);

            if (onConnect) {
                onConnect(false);
            }
            timeoutTime = 5000;
            client.destroy();
            client = null;
        };

        const connectionTimeout = function () {
            ws.socket.close();
            closeConnection('connection timeout');
        };

        const mqttKeepAlive = function () {
            if (closed) {
                return;
            }
            client.pingreq(null, function () {
                mqttKeepAliveTimer = setTimeout(mqttKeepAlive, 30000);
            });
        };

        const updateConnTimer = function (timeOut) {
            if (connTimer) {
                clearTimeout(connTimer);
            }
            connTimer = setTimeout(connectionTimeout, timeOut);
        };

        updateConnTimer(5000);

        client.connect({
            clientId: clientId,
            protocolVersion: 5,
            clean: false,
            username: 'blank',
            password: jwt
        });

        client.on('connack', function (packet) {
            if (packet.reasonCode !== 0) {
                closeConnection('Unable to login to mqtt server');
                return;
            }
            if (!packet.sessionPresent) {
                if (subscriptions.length > 0) {
                    log('Re subscribing all');
                    const subs = [];
                    const messageId = getNewMessageId();
                    for (let i = 0; i < subscriptions.length; i++) {
                        subscriptions[i].ack = false;
                        subscriptions[i].messageId = messageId;
                        subs.push({
                            topic: subscriptions[i].topic,
                            qos: 1
                        });
                    }
                    // eslint-disable-next-line no-unused-vars
                    const packet = {
                        messageId: messageId,
                        subscriptions: subs
                    };
                    client.subscribe(packet);
                }
            } else {
                log('connack', packet);
                log('Already subscribed');
            }
            updateConnTimer(60000);
            mqttKeepAliveTimer = setTimeout(mqttKeepAlive, 10000);
            if (onConnect) {
                onConnect(true);
            }
        });

        client.on('publish', function (packet) {
            if (closed) {
                return;
            }
            if (packet.qos > 0) {
                client.puback({
                    messageId: packet.messageId
                });
            }
            updateConnTimer(60000);
            if (onPublish) {
                onPublish(packet);
            }
        });

        client.on('suback', function (packet) {
            if (closed) {
                return;
            }
            if (packet.granted.find((element) => element > 1)) {
                for (let i = 0; i < subscriptions.length; i++) {
                    if (subscriptions[i].messageId === packet.messageId) {
                        if (subscriptions[i].index) {
                            log(
                                `Subscribe failed: ${subscriptions[i].topic} %c` +
                                getMqttError(packet.granted[subscriptions[i].index]),
                                'color: #F50'
                            );
                        } else {
                            log(
                                `Subscribe failed: ${subscriptions[i].topic} %c` +
                                getMqttError(packet.granted[0]),
                                'color: #F50'
                            );
                        }
                    }
                }
                clientEvents.emit(`suback:${packet.messageId}`, EVENT.VALID, false);
                delete pendingEvents[`suback:${packet.messageId}`];
            } else {
                for (let i = 0; i < subscriptions.length; i++) {
                    if (subscriptions[i].messageId === packet.messageId) {
                        subscriptions[i].ack = true;
                    }
                }
                clientEvents.emit(`suback:${packet.messageId}`, EVENT.VALID, true);
                delete pendingEvents[`suback:${packet.messageId}`];
            }
        });

        client.on('unsuback', function (packet) {
            if (closed) {
                return;
            }
            clientEvents.emit(`unsuback:${packet.messageId}`, EVENT.VALID, packet);
            delete pendingEvents[`unsuback:${packet.messageId}`];
        });

        client.on('puback', function (packet) {
            if (closed) {
                return;
            }
            clientEvents.emit(`puback:${packet.messageId}`, EVENT.VALID, packet);
            delete pendingEvents[`puback:${packet.messageId}`];
        });

        client.on('pingresp', function () {
            if (closed) {
                return;
            }
            updateConnTimer(60000);
        });

        client.on('close', function () {
            closeConnection('server closed');
        });

        // eslint-disable-next-line handle-callback-err
        client.on('error', function (error) {
            log('MQTT connection error', error);
        });

        const logoutSession = function () {
            closeConnection('Logged out', false);
        };

        return {
            logoutSession
        };
    };

    /**
     * Call after external successful login
     */
    const open = function (jwt, user_id) {
        currentSession = openWebSocket(jwt, user_id);
        lastUserAction = Date.now();
    };

    const close = function () {
        if (currentSession != null) {
            currentSession.logoutSession();
            currentSession = null;
        } else {
            if (onConnect) {
                onConnect(false);
            }
        }
    };

    /**
     *
     * @param {string} topic
     * @param {any} payload
     * @returns {
     *    Promise<
     *      {reason: number, error: string, sent: boolean}|
     *      {reason: string, sent: boolean}|
     *      {reason: string, data: UserProperties, reasonCode: *, error: (string|string[]|string), sent: boolean}
     *   >}
     */
    const publish = async function (topic, payload) {
        if (client === null) {
            return {
                sent: false,
                reason: 0x88,
                error: 'No network'
            };
        }
        const messageId = getNewMessageId();
        pendingEvents[`puback:${messageId}`] = true;
        client.publish({
            topic,
            messageId,
            qos: 1,
            payload
        });
        try {
            const [valid, puback] = await events.once(
                clientEvents,
                `puback:${messageId}`
            );
            return {
                sent: valid === EVENT.VALID,
                reasonCode: puback.reasonCode,
                reason: puback.properties.reasonString,
                data: puback.properties.userProperties,
                error:
                    puback.properties.userProperties &&
                    puback.properties.userProperties.error
                        ? puback.properties.userProperties.error
                        : ''
            };
        } catch (error) {
            return {
                sent: false,
                reason: error.toString()
            };
        }
    };

    /**
     *
     * @param {string} topic
     * @returns {boolean}
     */
    const isSubscribed = function (topic) {
        return subscriptions.findIndex(e => e.topic === topic) !== -1;
    };

    /**
     *
     * @param {string|string[]} topic
     * @returns {Promise<{subscribed: boolean, reason: string}|{subscribed: boolean, reason: any}|boolean>}
     */
    const subscribe = async function (topic) {
        if (client === null) {
            return false; // or throw error
        }
        const messageId = getNewMessageId();
        const subs = [];
        if (Array.isArray(topic)) {
            for (let i = 0; i < topic.length; i++) {
                subscriptions.push({
                    ack: false,
                    topic: topic[i],
                    messageId,
                    index: i
                });
                subs.push({
                    topic: topic[i],
                    qos: 1
                });
            }
        } else {
            subscriptions.push({
                ack: false,
                topic,
                messageId
            });
            subs.push({
                topic: topic,
                qos: 1
            });
        }

        pendingEvents[`suback:${messageId}`] = true;
        client.subscribe({
            messageId: messageId,
            subscriptions: subs
        });

        try {
            const [valid, result] = await events.once(
                clientEvents,
                `suback:${messageId}`
            );
            // return valid === EVENT.VALID && result === true;
            return {
                subscribed: valid === EVENT.VALID && result === true,
                reason: result
            };
        } catch (error) {
            return {
                subscribed: false,
                reason: error.toString()
            };
        }
    };

    /**
     *
     * @param {string|string[]} topic
     * @returns {Promise<{subscribed: boolean, reason: string}|{subscribed: boolean, reason: any}|boolean>}
     */
    const unSubscribe = async function (topic) {
        if (client === null) {
            return false; // or throw error
        }
        const messageId = getNewMessageId();

        const unSubs = [];
        if (Array.isArray(topic)) {
            for (let i = 0; i < topic.length; i++) {
                const index = subscriptions.findIndex(
                    (element) => element.topic === topic[i]
                );
                if (index > -1) {
                    subscriptions.splice(index, 1);
                }
                unSubs.push(topic[i]);
            }
        } else {
            const index = subscriptions.findIndex(
                (element) => element.topic === topic
            );
            if (index > -1) {
                subscriptions.splice(index, 1);
            }
            unSubs.push(topic);
        }

        const index = subscriptions.findIndex((element) => element.topic === topic);
        if (index > -1) {
            subscriptions.splice(index, 1);
        }
        pendingEvents[`unsuback:${messageId}`] = true;
        client.unsubscribe({
            messageId: messageId,
            unsubscriptions: unSubs,
            qos: 1
        });
        try {
            const [valid, result] = await events.once(
                clientEvents,
                `unsuback:${messageId}`
            );
            // return valid === EVENT.VALID && result === true;
            return {
                subscribed: valid === EVENT.VALID && result === true,
                reason: result
            };
        } catch (error) {
            return {
                subscribed: false,
                reason: error.toString()
            };
        }
    };

    /**
     *
     * @param {('publish'|'connect'|'login')} event
     * @param {function({Packet}|{boolean})} callback
     */
    const on = function (event, callback) {
        switch (event) {
            case 'publish':
                onPublish = callback;
                break;
            case 'connect':
                onConnect = callback;
                break;
        }
    };

    log('Starting connector for ' + clientId);

    return {
        open,
        close,
        publish,
        subscribe,
        unSubscribe,
        isSubscribed,
        on
    };
};

export default Connector;
