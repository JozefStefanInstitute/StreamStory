var async = require('async');
var path = require('path');
var fs = require('fs');
var mkdirp = require('mkdirp');

var express = require('express');
var bodyParser = require("body-parser");
var multer = require('multer');
var session = require('express-session');
var cookieParser = require('cookie-parser');

var SessionStore = require('./util/sessionstore.js');
var utils = require('./utils.js');
var broker = require('./broker.js');
var config = require('../config.js');
var fields = require('../fields.js');
var transform = require('./util/transform.js');
var fzi = require('./util/fzi_integration.js');
var externalAuth = require('./util/external_auth.js');

var ModelStore = require('./util/modelstore.js');
var WebSocketWrapper = require('./util/servicesutil.js');

var ssmodules = require('./ssmodules.js');

var perf = require('./util/perf_tools.js');

var throughput = perf.throughput();
// var latency = perf.latency();
// var toc = function () {};

var qmutil = qm.qm_util;

var UI_PATH = '/';
var LOGIN_PATH = '/login';
var API_PATH = '/api';
var DATA_PATH = '/data';
var WS_PATH = '/ws';

var LONG_REQUEST_TIMEOUT = 1000*60*60*24;   // 24 hours

var FZI_TOKEN_KEY = 'fzi-token';

var app = express();

var fileBuffH = {}; // if I store the file buffer directly into the session, the request takes forever to complete

var titles = {
    '': 'Index',
    'index.html': 'Index',
    'login.html': 'Login',
    'register.html': 'Register',
    'resetpassword.html': 'Reset Password',
    'dashboard.html': 'Dashboard',
    'ui.html': 'View Model',
    'profile.html': 'Profile'
};

var base;

var db;
var pipeline;
var modelStore;
var modelManager;

var counts = {};
var storeLastTm = {};
var totalCounts = 0;

var lastRawTime = -1;
var intensConfig = {};

function activateModel(model) {
    try {
        if (log.info()) {
            log.info('Activating an online model, ID: %s ...', model.getId());
        }

        modelStore.add(model);
        initStreamStoryHandlers(model, true);
        model.setActive(true);
    } catch (e) {
        log.error(e, 'Failed to activate real-time model!');
        throw e;
    }
}

function deactivateModel(model) {
    try {
        log.info('Deactivating an online model ...');
        modelStore.remove(model);
        initStreamStoryHandlers(model, false);
        model.setActive(false);
    } catch (e) {
        log.error(e, 'Failed to deactivate a model!');
    }
}

function closeBase(session) {
    if (session.base == null)
        return;

    if (log.debug())
        log.debug('Closing base ...');

    if (session.base != null) {
        if (session.base == base) {
            log.debug('Will not close base as it is the real-time base ...');
        } else {
            if (log.debug())
                log.debug('Closing base for user %s ...', session.username);

            if (!session.base.isClosed()) {
                session.base.close();
                log.debug('Base closed!');
            } else {
                log.debug('Base already closed, no need to close again!');
            }
        }
    }
}

//=====================================================
// SESSION
//=====================================================

function getModel(sessionId, session) {
    return session.model;
}

function getModelFile(session) {
    return session.modelFile;
}

function cleanUpSessionModel(sessionId, session) {
    if (log.debug())
        log.debug('Cleaning up session %s ...', sessionId);

    closeBase(session);

    delete session.base;
    delete session.model;
    delete session.modelId;
    delete session.modelFile;
}

function cleanUpSession(sessionId, session) {
    cleanUpSessionModel(sessionId, session);
    delete session.username;
}

function loginUser(session, opts) {
    if (opts.username == null) throw new Error('Usetname missing when logging in!');
    if (opts.theme == null) throw new Error('Theme missing when logging in!');

    session.username = opts.username;
    session.theme = opts.theme;
}

function isLoggedIn(session) {
    return session.username != null;
}

function saveToSession(sessionId, session, userBase, model, modelId, fname) {
    if (session.base != null)
        cleanUpSessionModel(sessionId, session);

    if (log.debug())
        log.debug('Saving new data to session %s ...', sessionId);

    if (userBase.isClosed())
        throw new Error('Tried to save a closed base to session!');

    session.base = userBase;
    session.model = model;
    session.modelId = modelId;
    session.modelFile = fname;

    if (log.debug())
        log.debug('Saved to session!');
}

//=====================================================
// UTILITY METHODS
//=====================================================

function getRequestedPage(req) {
    return req.path.split('/').pop();
}

function getRequestedPath(req) {
    var spl = req.path.split('/');
    spl.pop();
    return spl.pop();
}

function redirect(res, page) {
    if (log.debug())
        log.debug('Redirecting to %s ...', page);
    res.redirect(page);
}

function addRawMeasurement(val) {
    if (log.trace())
        log.trace('Received raw measurememnt %s ...', JSON.stringify(val));

    var insertVals = transform.transform(val);

    for (var i = 0; i < insertVals.length; i++) {
        var transformed = insertVals[i];

        var storeNm = transformed.store;
        var timestamp = transformed.timestamp;

        if (!(storeNm in counts)) counts[storeNm] = 0;
        if (!(storeNm in storeLastTm)) storeLastTm[storeNm] = 0;

        counts[storeNm]++;
        var prevTimestamp = storeLastTm[storeNm];

        if (totalCounts++ % config.RAW_PRINT_INTERVAL == 0 && log.debug())
            log.debug('Received raw data, inserting into store %s, time: %s ...', storeNm, new Date(timestamp).toString());
        if (timestamp <= prevTimestamp)
            throw new Error('Invalid time for a single measurement: ' + timestamp + ' <= ' + prevTimestamp);
        if (timestamp < lastRawTime)
            throw new Error('Invalid time! Current: ' + timestamp + ', prev: ' + lastRawTime);

        var insertVal = transformed.value;


        if (log.trace())
            log.trace('Inserting raw measurement %s', JSON.stringify(insertVal));

        // toc = latency.tic();

        pipeline.insertRaw(storeNm, insertVal);
        storeLastTm[storeNm] = timestamp;
        lastRawTime = timestamp;
    }
}

function initStreamStoryHandlers(model, enable) {
    if (model == null) {
        log.warn('StreamStory is NULL, cannot register callbacks ...');
        return;
    }

    log.info('Registering StreamStory callbacks for model %s ...', model.getId());

    if (enable) {
        log.debug('Registering state changed callback ...');
        model.onStateChanged(function (date, states) {
            // toc();
            // latency.print();

            if (log.debug())
                log.debug('State changed: %s', JSON.stringify(states));

            modelStore.sendMsg(model.getId(), JSON.stringify({
                type: 'stateChanged',
                content: states
            }));

            if (config.SAVE_STATES) {
                utils.appendLine('states.txt', JSON.stringify({
                    time: date.getTime(),
                    states: states
                }));
            }
        });

        log.debug('Registering anomaly callback ...');
        model.onAnomaly(function (desc) {
            if (log.warn())
                log.warn('Anomaly detected: %s TODO: currently ignoring!', desc);

            // TODO not notifying anyone!
        });

        log.debug('Registering outlier callback ...');
        model.onOutlier(function (ftrV) {
            if (log.debug())
                log.debug('Outlier detected!');

            // send to broker
            var brokerMsg = transform.genExpPrediction(100.1, 'minute', new Date().getTime);
            broker.send(broker.PREDICTION_PRODUCER_TOPIC, JSON.stringify(brokerMsg));

            // send to UI
            var msg = {
                type: 'outlier',
                content: ftrV
            }
            modelManager.sendMessage(model, msg, function (e) {
                if (e != null) {
                    log.error(e, 'Failed to send message to model: ' + model.getId());
                    return;
                }
            })
            // modelStore.sendMsg(model.getId(), JSON.stringify(msg));
        });

        log.debug('Registering prediction callback ...');
        model.onPrediction(function (date, currState, targetState, prob, probV, timeV) {
            if (log.debug())
                log.debug('Sending prediction, with PDF length: %d', probV.length);

            try {
                var _model = model.getModel();

                var currStateNm = _model.getStateName(currState);
                var targetStateNm = _model.getStateName(targetState);

                db.fetchStateProperty(model.getId(), targetState, 'eventId', function (e, eventId) {
                    if (e != null) {
                        log.error(e, 'Failed to fetch event ID from the database!');
                        return;
                    }

                    if (currStateNm == null || currStateNm.length == 0) currStateNm = currState;
                    if (targetStateNm == null || targetStateNm.length == 0) targetStateNm = targetState;

                    var uiMsg = {
                        type: 'statePrediction',
                        content: {
                            time: date.getTime(),
                            currState: currStateNm,
                            targetState: targetStateNm,
                            eventId: eventId,
                            probability: prob,
                            pdf: {
                                type: 'histogram',
                                probV: probV,
                                timeV: timeV
                            }
                        }
                    };

                    var currStateIds = _model.currState();
                    var stateId = currStateIds[0].id;
                    var level = currStateIds[0].height;

                    var details = model.stateDetails(stateId, level);
                    var metadata = {};

                    var obs = details.features.observations;
                    var contr = details.features.controls;
                    for (var i = 0; i < obs.length; i++) {
                        var ftr = obs[i];
                        metadata[ftr.name] = ftr.value;
                    }
                    for (i = 0; i < contr.length; i++) {
                        var contrFtr = contr[i];
                        metadata[contrFtr.name] = contrFtr.value;
                    }

                    var brokerMsg = transform.genHistPrediction(
                        date.getTime(),
                        eventId,
                        timeV,
                        probV,
                        model.getModel().getTimeUnit(),
                        metadata
                    );

                    async.parallel([
                        function sendUiMsg(xcb) {
                            // var mid = model.getId();
                            // modelStore.sendMsg(model.getId(), JSON.stringify(uiMsg));
                            modelManager.sendMessage(model, uiMsg, xcb);
                        },
                        function sendBrokerMsg(xcb) {
                            var mid = model.getId();
                            var brokerMsgStr = JSON.stringify(brokerMsg);
                            broker.send(broker.PREDICTION_PRODUCER_TOPIC, brokerMsgStr);

                            var topics = fzi.getTopics(fzi.PREDICTION_OPERATION, mid);
                            for (i = 0; i < topics.length; i++) {
                                var topic = topics[i].output;
                                log.debug('Sending a prediction message to topic \'%s\'', topic);
                                broker.send(topic, brokerMsgStr);
                            }
                            xcb();
                        }
                    ], function (e) {
                        if (e != null) {
                            log.error('Failed to send target state prediction!');
                        }
                    })
                });
            } catch (e) {
                log.error(e, 'Failed to send target state prediction!');
            }
        });

        log.debug('Registering activity callback ...');
        model.getModel().onActivity(function (startTm, endTm, activityName) {
            if (log.debug())
                log.debug('Detected activity %s at time %s to %s!', activityName, startTm.toString(), endTm.toString());

            var start = startTm.getTime();
            var end = endTm.getTime();

            async.parallel([
                function sendUiMsg(xcb) {
                    var uiMsg = {
                        type: 'activity',
                        content: {
                            start: start,
                            end: end,
                            name: activityName
                        }
                    };

                    // modelStore.sendMsg(model.getId(), JSON.stringify(uiMsg));
                    modelManager.sendMessage(model, uiMsg, xcb);
                },
                function sendBrokerMsg(xcb) {
                    if (config.USE_BROKER) {
                        var brokerMsgStr = JSON.stringify({
                            activityId: activityName,
                            startTime: start,
                            endTime: end,
                            description: '(empty)'  // TODO description
                        });

                        var topics = fzi.getTopics(fzi.ACTIVITY_OPERATION, model.getId());
                        for (var i = 0; i < topics.length; i++) {
                            var topic = topics[i].output;
                            log.debug('Sending activity to topic: %s', topic);
                            broker.send(topic, brokerMsgStr);
                        }
                    }
                    xcb();
                },
                function saveToFine(xcb) {
                    if (config.SAVE_ACTIVITIES) {
                        utils.appendLine('activities-' + model.getId() + '.csv',  startTm.getTime() + ',' + endTm.getTime() + ',"' + activityName.replace(/\"/g, '\\"') + '"');
                    }
                    xcb();
                }
            ], function (e) {
                if (e != null) {
                    log.error(e, 'Failed to send activity message!');
                    return;
                }
            })
        });
    } else {
        log.debug('Removing StreamStory handlers for model %s ...', model.getId());
        log.debug('Removing state changed callback ...');
        model.onStateChanged(null);
        log.debug('Removing anomaly callback ...');
        model.onAnomaly(null);
        log.debug('Removing outlier callback ...');
        model.onOutlier(null);
        log.debug('Removing prediction callback ...');
        model.onPrediction(null);
        log.debug('Removing activity callback ...');
        model.getModel().onActivity(null);
    }
}

function sendPrediction(msg, timestamp, eventProps) {
    var perMonth = msg.content.pdf.lambda;
    var perHour = perMonth / (30*24);

    var brokerMsg = transform.genExpPrediction(perHour, 'hour', timestamp, eventProps);

    var modelMsgStr = (function () {
        var msgCpy = utils.clone(msg);
        msgCpy.time = msg.time.getTime();
        return JSON.stringify(msgCpy);
    })();
    // var modelMsgStr = JSON.stringify(msg);
    var brokerMsgStr = JSON.stringify(brokerMsg);

    if (log.debug()) {
        log.debug('Sending exponential prediction to broker: %s', brokerMsgStr);
        log.debug('Sending exponential prediciton to all the models: %s', modelMsgStr)
    }

    broker.send(broker.PREDICTION_PRODUCER_TOPIC, brokerMsgStr);
    modelStore.distributeMsg(modelMsgStr);
}

function initPipelineHandlers() {
    log.info('Initializing pipeline callbacks ...');

    pipeline.onValue(function (val) {
        if (log.trace())
            log.trace('Inserting value into StreamStories ...');
        modelStore.updateModels(val);

        if (config.SAVE_STATES) {
            var models = modelStore.getActiveModels();
            for (var modelN = 0; modelN < models.length; modelN++) {
                var model = models[modelN];
                var ftrPred = model.getModel().predictNextState({
                    useFtrV: true,
                    futureStateN: -1
                });
                var mcPred = model.getModel().predictNextState({
                    useFtrV: false,
                    futureStateN: -1
                });

                var baseFName = 'predictions-' + model.getId();

                utils.appendLine(baseFName + '-pred.json', JSON.stringify(ftrPred));
                utils.appendLine(baseFName + '-nopred.json', JSON.stringify(mcPred));
            }
        }
    });

    // configure coefficient callback
    (function () {
        log.info('Fetching intensities from DB ...');
        var lambdaProps = [
            'deviation_extreme_lambda',
            'deviation_major_lambda',
            'deviation_significant_lambda',
            'deviation_minor_lambda'
        ];

        db.getMultipleConfig({properties: lambdaProps}, function (e, result) {
            if (e != null) {
                log.error(e, 'Failed to fetch intensities from DB!');
                return;
            }

            for (var i = 0; i < result.length; i++) {
                var entry = result[i];
                var property = entry.property;
                var val = parseFloat(entry.value);

                intensConfig[property] = val;
            }

            // friction coefficient
            log.debug('Creating coefficient callback ...');
            pipeline.onCoefficient(function (opts) {
                var pdf = null;

                log.info('coefficient callback called with options:\n' + JSON.stringify(opts));

                // send the coefficient to the broker, so that other components can do
                // calculations based no it
                (function () {
                    var optsClone = utils.clone(opts);
                    optsClone.timestamp = opts.time.getTime();
                    delete optsClone.time;
                    var brokerMsgStr = JSON.stringify(optsClone);

                    if (log.debug())
                        log.debug('Sending coefficient to the broker: %s', brokerMsgStr);

                    (function () {
                        var topic;
                        switch (optsClone.eventId) {
                            case 'swivel':
                                topic = broker.TOPIC_PUBLISH_COEFFICIENT_SWIVEL;
                                break;
                            case 'gearbox':
                                topic = broker.TOPIC_PUBLISH_COEFFICIENT_GEARBOX;
                                break;
                            default:
                                throw new Error('Invalid event ID for coefficient: ' + optsClone.eventId);
                        }

                        broker.send(topic, brokerMsgStr);
                    })();

                    // send coefficient to any topics listening from FZI integration
                    (function () {
                        var operation;
                        switch (optsClone.eventId) {
                            case 'swivel':
                                operation = fzi.OPERATION_FRICTION_SWIVEL;
                                break;
                            case 'gearbox':
                                operation = fzi.OPERATION_FRICTION_GEARBOX;
                                break;
                            default:
                                throw new Error('Invalid event ID for coefficient: ' + optsClone.eventId);
                        }

                        if (log.debug())
                            log.debug('Will send prediction message to FZI topics:\n%s', brokerMsgStr);

                        var topics = fzi.getTopics(operation);
                        for (var i = 0; i < topics.length; i++) {
                            var topic = topics[i].output;
                            log.debug('Sending a friction message to topic \'%s\'', topic);
                            broker.send(topic, brokerMsgStr);
                        }
                    })();
                })()

                var zscore = opts.zScore;
                if (zscore >= 2) {
                    if (zscore >= 5) {
                        pdf = {
                            type: 'exponential',
                            lambda: intensConfig.deviation_extreme_lambda       // degradation occurs once per month
                        };
                    } else if (zscore >= 4) {                                   // major deviation
                        pdf = {
                            type: 'exponential',
                            lambda: intensConfig.deviation_major_lambda         // degradation occurs once per two months
                        };
                    } else if (zscore >= 3) {                                   // significant deviation
                        pdf = {
                            type: 'exponential',
                            lambda: intensConfig.deviation_significant_lambda   // degradation occurs once per year
                        };
                    } else {                                                    // (zscore >= 2) minor deviation
                        pdf = {
                            type: 'exponential',
                            lambda: intensConfig.deviation_minor_lambda         // degradation occurs once per two years
                        };
                    }

                    (function () {
                        var timestamp = opts.time.getTime();
                        var optsCpy = utils.clone(opts);
                        optsCpy.time = timestamp;
                        modelStore.distributeMsg(JSON.stringify({
                            type: 'coeff',
                            content: optsCpy
                        }));
                    })();

                    if (pdf != null) {
                        if (log.debug())
                            log.debug('Sending prediction message based on the friction coefficient ...')

                        var msg = {
                            type: 'prediction',
                            content: {
                                time: opts.time,
                                eventId: opts.eventId,
                                pdf: pdf
                            }
                        };

                        var proasenseEventProps = {
                            coeff: opts.value,
                            std: opts.std,
                            zScore: opts.zScore
                        }

                        sendPrediction(msg, opts.time, proasenseEventProps);
                    }
                }
            });
        });
    })();
}

function initLoginRestApi() {
    log.info('Initializing Login REST services ...');

    app.post(LOGIN_PATH + '/login', function (req, res) {
        try {
            var session = req.session;

            var username = req.body.email;
            var password = req.body.password;

            if (log.debug())
                log.debug('Loggin in user: %s', username);

            if (username == null || username == '') {
                session.warning = 'Email missing!';
                redirect(res, '../login.html');
                return;
            }

            if (password == null || password == '') {
                session.warning = 'Password missing!';
                redirect(res, '../login.html');
                return;
            }

            db.fetchUserByEmail(username, function (e, user) {
                if (e != null) {
                    log.error(e, 'Exception while checking if user exists!');
                    utils.handleServerError(e, req, res);
                    return;
                }

                if (user == null) {
                    session.warning = 'Invalid email or password!';
                    redirect(res, '../login.html');
                    return;
                }

                var hash = utils.hashPassword(password);

                if (hash != user.passwd) {
                    session.warning = 'Invalid email or password!';
                    redirect(res, '../login.html');
                    return;
                } else {
                    loginUser(session, {
                        username: user.email,
                        theme: user.theme
                    });
                    redirect(res, '../dashboard.html');
                }
            });
        } catch (e) {
            utils.handleServerError(e, req, res);
        }
    });

    app.post(LOGIN_PATH + '/register', function (req, res) {
        try {
            var session = req.session;

            var username = req.body.email;
            var password = req.body.password;
            var password1 = req.body.password1;

            if (log.debug())
                log.debug('Registering user: %s', username);

            if (username == null || username == '') {
                session.warning = 'Email missing!';
                redirect(res, '../register.html');
                return;
            }

            if (password == null || password == '') {
                session.warning = 'Password missing!';
                redirect(res, '../register.html');
                return;
            }

            if (password.length < 4) {
                session.warning = 'The password must be at least 6 characters long!';
                redirect(res, '../register.html');
                return;
            }

            if (password1 == null || password1 == '') {
                session.warning = 'Please repeat password!';
                redirect(res, '../register.html');
                return;
            }

            if (password != password1) {
                session.warning = 'Passwords don\'t match!';
                redirect(res, '../register.html');
                return;
            }

            db.userExists(username, function (e, exists) {
                if (e != null) {
                    log.error(e, 'Exception while checking if user exists!');
                    utils.handleServerError(e, req, res);
                    return;
                }

                if (exists) {
                    session.warning = 'Email "' + username + '" already taken!';
                    redirect(res, '../register.html');
                    return;
                } else {
                    var hash = utils.hashPassword(password);
                    db.createUser(username, hash, function (e1) {
                        if (e1 != null) {
                            log.error(e1, 'Exception while creating a new user!');
                            utils.handleServerError(e1, req, res);
                            return;
                        }

                        loginUser(session, { username: username, theme: 'dark' });
                        redirect(res, '../dashboard.html');
                    });
                }
            });
        } catch (e) {
            utils.handleServerError(e, req, res);
        }
    });

    app.post(LOGIN_PATH + '/resetPassword', function (req, res) {
        try {
            var session = req.session;
            var email = req.body.email;

            var password = utils.genPassword();
            var hash = utils.hashPassword(password);

            db.userExists(email, function (e, exists) {
                if (e != null) {
                    utils.handleServerError(e, req, res);
                    return;
                }

                if (!exists) {
                    session.error = 'Invalid email address!';
                    redirect(res, '../resetpassword.html');
                } else {
                    db.updatePassword(email, hash, function (e1) {
                        if (e1 != null) {
                            log.error(e, 'Failed to update password!');
                            utils.handleServerError(e1, req, res);
                            return;
                        }

                        var opts = {
                            password: password,
                            email: email
                        }

                        utils.sendEmail(opts, function (e2) {
                            if (e2 != null) {
                                log.error(e2, 'Failed to send email!');
                                utils.handleServerError(e2, req, res);
                                return;
                            }

                            session.message = 'Your new password has been sent to ' + email + '!';
                            redirect(res, '../resetpassword.html');
                        })
                    });
                }
            })
        } catch (e) {
            log.error(e, 'Exception while resetting password!');
            utils.handleServerError(e, req, res);
        }
    });

    app.post(API_PATH + '/changePassword', function (req, res) {
        try {
            var session = req.session;

            var email = session.username;

            var old = req.body.old;
            var password = req.body.newP;
            var password1 = req.body.repeat;

            if (password == null || password == '') {
                utils.handleBadInput(res, 'Password missing!');
                return;
            }

            if (password.length < 4) {
                utils.handleBadInput(res, 'The password must be at least 6 characters long!');
                return;
            }

            if (password1 == null || password1 == '') {
                utils.handleBadInput(res, 'Please repeat password!');
                return;
            }

            if (password != password1) {
                utils.handleBadInput(res, 'Passwords don\'t match!');
                return;
            }

            var hashOld = utils.hashPassword(old);

            db.fetchUserPassword(email, function (e, storedHash) {
                if (e != null) {
                    log.error(e, 'Exception while fetching user password!');
                    utils.handleServerError(e, req, res);
                    return;
                }

                if (hashOld != storedHash) {
                    utils.handleBadInput(res, 'Passwords don\'t match!');
                    return;
                }

                var hash = utils.hashPassword(password);

                db.updatePassword(email, hash, function (e1) {
                    if (e1 != null) {
                        log.error(e, 'Failed to update password!');
                        utils.handleServerError(e1, req, res);
                        return;
                    }

                    res.status(204);    // no content
                    res.end();
                });
            });
        } catch (e) {
            log.error(e, 'Exception while changing password!');
            utils.handleServerError(e, req, res);
        }
    });

    app.post(API_PATH + '/logout', function (req, res) {
        try {
            cleanUpSession(req.sessionID, req.session);

            if (config.AUTHENTICATION_EXTERNAL) {
                redirect(res, '../dashboard.html');
            } else {
                redirect(res, '../login.html');
            }
        } catch (e) {
            utils.handleServerError(e, req, res);
        }
    });
}

function initStreamStoryRestApi() {
    log.info('Initializing StreamStory REST services ...');

    {
        log.debug('Registering save service ...');
        app.post(API_PATH + '/save', function (req, res) {
            var session = req.session;
            var sessionId = req.sessionID;

            try {
                var model = getModel(sessionId, session);
                var positions = req.body.positions != null ? JSON.parse(req.body.positions) : null;

                if (model == null) {
                    res.status(401);    // unauthorized
                    res.end();
                    return;
                }

                if (positions != null) {
                    if (log.debug())
                        log.debug('Saving node positions ...');
                    model.getModel().setStateCoords(positions);
                }

                var modelFile = getModelFile(session);

                if (modelFile == null)
                    throw new Error('Model file missing when saving!');

                model.save(modelFile);
                res.status(204);
                res.end();
            } catch (e) {
                log.error(e, 'Failed to save visualization model!');
                utils.handleServerError(e, req, res);
            }
        });
    }

    {
        log.debug('Registering set parameter service ...');

        app.post(API_PATH + '/param', function (req, res) {
            try {
                var paramName = req.body.paramName;
                var paramVal = parseFloat(req.body.paramVal);

                if (log.debug())
                    log.debug('Setting parameter %s to value %d ...', paramName, paramVal);

                var model = getModel(req.sessionID, req.session);

                var paramObj = {};
                paramObj[paramName] = paramVal;

                model.getModel().setParams(paramObj);
                res.status(204);    // no content
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query MHWirth multilevel visualization!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/param', function (req, res) {
            try {
                var param = req.query.paramName;
                var model = getModel(req.sessionID, req.session);

                var val = model.getModel().getParam(param);
                res.send({ parameter: param, value: val });
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query MHWirth multilevel visualization!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/timeUnit', function (req, res) {
            try {
                var model = getModel(req.sessionID, req.session);
                res.send({ value: model.getModel().getTimeUnit() });
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query MHWirth multilevel visualization!');
                utils.handleServerError(e, req, res);
            }
        });
    }

    {
        log.debug('Registering multilevel service at drilling/multilevel ...');

        // get the StreamStory model
        app.get(API_PATH + '/model', function (req, res) {
            try {
                var model = getModel(req.sessionID, req.session);

                log.debug('Querying MHWirth multilevel model ...');
                res.send(model.getVizState());
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query for the model!');
                utils.handleServerError(e, req, res);
            }
        });

        // submodel
        app.get(API_PATH + '/subModel', function (req, res) {
            try {
                var model = getModel(req.sessionID, req.session);
                var stateId = parseInt(req.query.stateId);

                if (log.debug())
                    log.debug('Fetching sub model for state: %d ...', stateId);

                res.send(model.getSubModelJson(stateId));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query for a sub-model!');
                utils.handleServerError(e, req, res);
            }
        });

        // path from state
        app.get(API_PATH + '/path', function (req, res) {
            try {
                var model = getModel(req.sessionID, req.session);
                var stateId = parseInt(req.query.stateId);
                var height = parseFloat(req.query.height);
                var length = parseInt(req.query.length);
                var probThreshold = parseFloat(req.query.probThreshold);

                if (log.debug())
                    log.debug('Fetching state path for state: %d on height %d ...', stateId, height);

                res.send(model.getStatePath(stateId, height, length, probThreshold));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query for state path!');
                utils.handleServerError(e, req, res);
            }
        });

        // multilevel analysis
        app.get(API_PATH + '/features', function (req, res) {
            try {
                var model = getModel(req.sessionID, req.session);
                log.debug('Fetching all the features ...');
                res.send(model.getFtrDesc());
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query MHWirth multilevel visualization!');
                utils.handleServerError(e, req, res);
            }
        });
    }

    {
        log.debug('Registering transition model service ...');

        // multilevel analysis
        app.get(API_PATH + '/transitionModel', function (req, res) {
            try {
                var level = parseFloat(req.query.level);
                var model = getModel(req.sessionID, req.session);

                if (log.debug())
                    log.debug('Fetching transition model for level: %.3f', level);

                res.send(model.getModel().getTransitionModel(level));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query MHWirth multilevel visualization!');
                utils.handleServerError(e, req, res);
            }
        });
    }

    {
        log.debug('Registering future and states services ...');

        // multilevel analysis
        app.get(API_PATH + '/currentState', function (req, res) {
            try {
                var level = parseFloat(req.query.level);
                var model = getModel(req.sessionID, req.session);

                if (log.debug())
                    log.debug('Fetching current state for level ' + level);

                var result = model.currState(level);

                if (log.debug())
                    log.debug("Current state: %s", JSON.stringify(result));

                res.send(result);
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query MHWirth multilevel visualization!');
                utils.handleServerError(e, req, res);
            }
        });

        // multilevel analysis
        app.get(API_PATH + '/futureStates', function (req, res) {
            try {
                var level = parseFloat(req.query.level);
                var currState = parseInt(req.query.state);

                var model = getModel(req.sessionID, req.session);

                if (req.query.time == null) {
                    log.debug('Fetching future states currState: %d, height: %d', currState, level);
                    res.send(model.futureStates(level, currState));
                    res.end();
                } else {
                    var time = parseFloat(req.query.time);
                    log.debug('Fetching future states, currState: %d, level: %d, time: %d', currState, level, time);
                    res.send(model.futureStates(level, currState, time));
                    res.end();
                }
            } catch (e) {
                log.error(e, 'Failed to query MHWirth multilevel visualization!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/pastStates', function (req, res) {
            try {
                var level = parseFloat(req.query.level);
                var currState = parseInt(req.query.state);

                var model = getModel(req.sessionID, req.session);

                if (req.query.time == null) {
                    log.debug('Fetching past states currState: %d, height: %d', currState, level);
                    res.send(model.pastStates(level, currState));
                    res.end();
                } else {
                    var time = parseFloat(req.query.time);
                    log.debug('Fetching past states, currState: %d, level: %d, time: %d', currState, level, time);
                    res.send(model.pastStates(level, currState, time));
                    res.end();
                }
            } catch (e) {
                log.error(e, 'Failed to query MHWirth multilevel visualization!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/timeDist', function (req, res) {
            try {
                var stateId = parseInt(req.query.stateId);
                var time = parseFloat(req.query.time);
                var height = parseFloat(req.query.level);

                var model = getModel(req.sessionID, req.session);

                if (log.debug())
                    log.debug('Fetching probability distribution of states at height %d from state %d at time %d ...', height, stateId, time);

                res.send(model.getModel().probsAtTime(stateId, height, time));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query MHWirth multilevel visualization!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/history', function (req, res) {
            try {
                var level = parseFloat(req.query.level);
                var model = getModel(req.sessionID, req.session);

                if (log.debug())
                    log.debug('Fetching history for level %d', level);

                res.send(model.getModel().histStates(level));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query MHWirth multilevel visualization!');
                utils.handleServerError(e, req, res);
            }
        });
    }

    (function () {
        log.info('Registering state details service ...');

        // state details
        app.get(API_PATH + '/stateDetails', function (req, res) {
            try {
                var stateId = parseInt(req.query.stateId);
                var height = parseFloat(req.query.level);

                var model = getModel(req.sessionID, req.session);

                if (log.debug())
                    log.debug('Fetching details for state: %d', stateId);

                var details = model.stateDetails(stateId, height);

                db.fetchStateProperties(model.getId(), stateId, ['eventId', 'description'], function (e, stateProps) {
                    if (e != null) {
                        utils.handleServerError(e, req, res);
                        return;
                    }

                    details.undesiredEventId = stateProps.eventId;
                    details.description = stateProps.description;

                    res.send(details);
                    res.end();
                });
            } catch (e) {
                log.error(e, 'Failed to query state details!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/stateHistory', function (req, res) {
            try {
                log.debug('Querying state history ...');

                var offset = req.query.offset != null ? parseFloat(req.query.offset) : undefined;
                var range = req.query.range != null ? parseFloat(req.query.range) : undefined;
                var maxStates = req.query.n != null ? parseInt(req.query.n) : undefined;

                if (offset == null) {
                    utils.handleBadInput(res, "Missing parameter offset!");
                    return;
                }
                if (range == null) {
                    utils.handleBadInput(res, "Missing parameter range!");
                    return;
                }
                if (maxStates == null) {
                    utils.handleBadInput(res, 'Missing parameter maxStates!');
                    return;
                }

                if (log.debug())
                    log.debug('Using parameters offset: %d, relWindowLen: %d', offset, range);

                var model = getModel(req.sessionID, req.session);

                var result = model.getHistoricalStates(offset, range, maxStates);

                if (log.debug())
                    log.debug('Writing to output stream ...');

                // I have to write the objects to the stream manually, otherwise I can get
                // an out of memory error
                var key;
                res.write('{');
                for (key in result) {
                    if (key != 'window' && result.hasOwnProperty(key)) {
                        res.write('"' + key + '":');
                        res.write(typeof result[key] == 'string' ? ('"' + result[key] + '"') : (result[key] + ''));
                        res.write(',');
                    }
                }
                res.write('"window": [')
                for (var i = 0; i < result.window.length; i++) {
                    res.write('{');
                    var scaleObj = result.window[i];
                    for (key in scaleObj) {
                        if (key != 'states' && scaleObj.hasOwnProperty(key)) {
                            res.write('"' + key + '":');
                            res.write(typeof scaleObj[key] == 'string' ? ('"' + scaleObj[key] + '"') : (scaleObj[key] + ''));
                            res.write(',');
                        }
                    }
                    res.write('"states":[');
                    var states = scaleObj.states;
                    for (var stateN = 0; stateN < states.length; stateN++) {
                        res.write(JSON.stringify(states[stateN]));
                        if (stateN < states.length-1) {
                            res.write(',');
                        }
                    }
                    res.write(']');
                    res.write('}');
                    if (i < result.window.length-1) {
                        res.write(',');
                    }
                }
                res.write(']}');
                res.end();
            } catch (e) {
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/modelDetails', function (req, res) {
            try {
                var session = req.session;
                var username = session.username;
                var modelId = parseInt(req.query.modelId);

                if (log.debug())
                    log.debug('Fetching model details for model: %d', modelId);

                db.fetchModel(modelId, function (e, modelConfig) {
                    if (e != null) {
                        log.error(e, 'Failed to fetch model details!');
                        utils.handleServerError(e, req, res);
                        return;
                    }

                    res.send({
                        mid: modelConfig.mid,
                        name: modelConfig.name,
                        description: modelConfig.description,
                        dataset: modelConfig.dataset,
                        isOnline: modelConfig.is_realtime == 1,
                        creator: modelConfig.username,
                        creationDate: modelConfig.date_created,
                        isPublic: modelConfig.is_public == 1,
                        isActive: modelConfig.is_active == 1,
                        isOwner: modelConfig.username == username
                    });
                    res.end();
                });
            } catch (e) {
                log.error(e, 'Failed to query state details!');
                utils.handleServerError(e, req, res);
            }
        });

        app.post(API_PATH + '/modelDescription', function (req, res) {
            try {
                var mid = req.body.modelId;
                var desc = req.body.description;

                if (log.debug())
                    log.debug('Setting description for model %s', mid);

                if (desc == '') desc = null;

                db.setModelDescription(mid, desc, function (e) {
                    if (e != null) {
                        log.error(e, 'Failed to update model description!');
                        utils.handleServerError(e, req, res);
                        return;
                    }

                    res.status(204);    // no content
                    res.end();
                });
            } catch (e) {
                log.error(e, 'Failed to set model details!');
                utils.handleServerError(e, req, res);
            }
        });

        app.post(API_PATH + '/activity', function (req, res) {
            try {
                var session = req.session;

                var model = getModel(req.sessionID, req.session);
                var name = req.body.name;
                var sequence = JSON.parse(req.body.sequence);

                if (log.debug())
                    log.debug('Setting activity %s for model %d with transitions %s', name, model.getId(), JSON.stringify(sequence));

                // perform checks
                if (name == null || name == '') {
                    utils.handleBadInput(res, 'Activity name missing!');
                    return;
                }
                if (sequence == null || sequence.length == 0) {
                    utils.handleBadInput(res, 'Missing the sequence of states!');
                    return;
                }
                for (var i = 0; i < sequence.length; i++) {
                    var stateIds = sequence[i];
                    if (stateIds == null || stateIds.length == 0) {
                        utils.handleBadInput(res, 'Empty states in sequence!');
                        return;
                    }
                }

                // set the activity
                model.getModel().setActivity(name, sequence);
                // save the model
                var fname = getModelFile(session);
                if (log.debug())
                    log.debug('Saving model to file: %s', fname);
                model.save(fname);

                res.status(204);    // no content
                res.end();
            } catch (e) {
                log.error(e, 'Failed to set activity!');
                utils.handleServerError(e, req, res);
            }
        });

        app.post(API_PATH + '/removeActivity', function (req, res) {
            try {
                var session = req.session;
                var model = getModel(req.sessionID, session);
                var name = req.body.name;

                if (log.debug())
                    log.debug('Removing activity %s for model %d ...', name, model.getId());

                if (name == null || name == '') {
                    utils.handleBadInput(res, 'Activity name missing!');
                    return;
                }

                model.getModel().removeActivity(name);
                var fname = getModelFile(session);
                if (log.debug())
                    log.debug('Saving model to file: %s', fname);
                model.save(fname);

                res.status(204);    // no content
                res.end();
            } catch (e) {
                log.error(e, 'Failed to set activity!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/targetProperties', function (req, res) {
            try {
                var stateId = parseInt(req.query.stateId);

                var model = getModel(req.sessionID, req.session);

                if (log.debug())
                    log.debug('Fetching target details for state: %d', stateId);

                var isUndesired = model.getModel().isTarget(stateId);

                if (isUndesired) {
                    db.fetchStateProperty(model.getId(), stateId, 'eventId', function (e, eventId) {
                        if (e != null) {
                            utils.handleServerError(e, req, res);
                            return;
                        }

                        res.send({ isUndesired: isUndesired, eventId: eventId });
                        res.end();
                    });
                } else {
                    res.send({ isUndesired: isUndesired });
                    res.end();
                }
            } catch (e) {
                log.error(e, 'Failed to query target details!');
                utils.handleServerError(e, req, res);
            }
        });

        // state explanation
        app.get(API_PATH + '/explanation', function (req, res) {
            try {
                var stateId = parseInt(req.query.stateId);

                var model = getModel(req.sessionID, req.session);

                if (log.debug())
                    log.debug('Fetching explanation for state: %d', stateId);

                res.send(model.explainState(stateId));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query state details!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/stateNarration', function (req, res) {
            try {
                var model = getModel(req.sessionID, req.session);
                var stateId = parseInt(req.query.stateId);

                if (log.trace())
                    log.trace('Fetching time explanation for state %d ...', stateId);

                res.send(model.narrateState(stateId));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query time explanation!');
                utils.handleServerError(e, req, res);
            }
        });

        // histograms
        app.get(API_PATH + '/histogram', function (req, res) {
            try {
                var stateId = parseInt(req.query.stateId);
                var ftrIdx = parseInt(req.query.feature);

                var model = getModel(req.sessionID, req.session);

                if (log.trace())
                    log.trace('Fetching histogram for state %d, feature %d ...', stateId, ftrIdx);

                res.send(model.histogram(ftrIdx, stateId));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query histogram!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/transitionHistogram', function (req, res) {
            try {
                var sourceId = parseInt(req.query.sourceId);
                var targetId = parseInt(req.query.targetId);
                var ftrId = parseInt(req.query.feature);

                var model = getModel(req.sessionID, req.session);

                if (log.trace())
                    log.trace('Fetching transition histogram for transition %d -> %d, feature %d ...', sourceId, targetId, ftrId);

                res.send(model.transitionHistogram(sourceId, targetId, ftrId));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query histogram!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/timeHistogram', function (req, res) {
            try {
                var model = getModel(req.sessionID, req.session);
                var stateId = parseInt(req.query.stateId);

                if (log.trace())
                    log.trace('Fetching time histogram for state %d ...', stateId);

                res.send(model.getModel().timeHistogram(stateId));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query histogram!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/timeExplain', function (req, res) {
            try {
                var model = getModel(req.sessionID, req.session);
                var stateId = parseInt(req.query.stateId);

                if (log.trace())
                    log.trace('Fetching time explanation for state %d ...', stateId);

                res.send(model.getModel().getStateTypTimes(stateId));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query time explanation!');
                utils.handleServerError(e, req, res);
            }
        });



        app.get(API_PATH + '/targetFeature', function (req, res) {
            try {
                var height = parseFloat(req.query.height);
                var ftrIdx = parseInt(req.query.ftr);

                var model = getModel(req.sessionID, req.session);

                if (log.debug())
                    log.debug('Fetching distribution for feature "%d" for height %d ...', ftrIdx, height);

                res.send(model.getFtrDist(height, ftrIdx));
                res.end();
            } catch (e) {
                log.error(e, 'Failed to fetch the distribution of a feature!');
                utils.handleServerError(e, req, res);
            }
        });

        app.post(API_PATH + '/stateProperties', function (req, res) {
            var stateId, stateNm;

            try {
                var session = req.session;

                var model = getModel(req.sessionID, session);
                var mid = session.modelId;

                stateId = parseInt(req.body.id);
                stateNm = req.body.name;
                var description = req.body.description;

                if (stateNm != null) {
                    if (log.debug())
                        log.debug('Setting name of state %d to %s ...', stateId, stateNm);

                    model.getModel().setStateName(stateId, stateNm);
                }
                else {
                    if (log.debug())
                        log.debug('Clearing name of state %d ...', stateId);

                    model.getModel().clearStateName(stateId);
                }

                var fname;
                var props;
                if (!model.isOnline()) {
                    fname = getModelFile(session);
                    if (log.debug())
                        log.debug('Saving model to file: %s', fname);
                    model.save(fname);

                    props = {
                        description: description
                    };

                    db.setStateProperties(mid, stateId, props, function (e) {
                        if (e != null) {
                            utils.handleServerError(e, req, res);
                            return;
                        }

                        res.status(204);    // no content
                        res.end();
                    });
                }
                else {
                    var isUndesired = JSON.parse(req.body.isUndesired);
                    var eventId = req.body.eventId;

                    if (isUndesired && (eventId == null || eventId == '')) {
                        log.warn('The state is marked undesired, but the eventId is missing!');
                        utils.handleBadInput(res, 'Undesired event without an event id!');
                        return;
                    }

                    if (log.debug())
                        log.debug('Setting undesired state: %d, isUndesired: ' + isUndesired, stateId);

                    if (model.getModel().isTarget(stateId) != isUndesired)
                        model.getModel().setTarget(stateId, isUndesired);
                    fname = getModelFile(session);

                    if (log.debug())
                        log.debug('Saving model to file: %s', fname);

                    fname = getModelFile(session);
                    model.save(fname);

                    props = {
                        eventId: isUndesired ? eventId : undefined,
                        description: description
                    }
                    db.setStateProperties(mid, stateId, props, function (e) {
                        if (e != null) {
                            utils.handleServerError(e, req, res);
                            return;
                        }

                        res.status(204);    // no content
                        res.end();
                    });
                }
            } catch (e) {
                log.error(e, 'Failed to set name of state %d to %s', stateId, stateNm);
                utils.handleServerError(e, req, res);
            }
        });

        app.post(API_PATH + '/setControl', function (req, res) {
            var ftrId, val;

            try {
                ftrId = parseInt(req.body.ftrIdx);
                val = parseFloat(req.body.val);
                var stateId = req.body.stateId != null ? parseInt(req.body.stateId) : null;

                var model = getModel(req.sessionID, req.session);

                if (log.debug())
                    log.debug('Changing control %d to value %d ...', ftrId, val);

                model.setControlVal({ ftrId: ftrId, val: val, stateId: stateId});
                res.send(model.getVizState());
                res.end();
            } catch (e) {
                log.error(e, 'Failed to control %d by factor %d', ftrId, val);
                utils.handleServerError(e, req, res);
            }
        });

        app.post(API_PATH + '/resetControl', function (req, res) {
            try {
                var ftrId = req.body.ftrIdx != null ? parseInt(req.body.ftrIdx) : null;
                var stateId = req.body.stateId != null ? parseInt(req.body.stateId) : null;

                var model = getModel(req.sessionID, req.session);

                if (model == null) throw new Error('Model is null, has the session expired?');

                if (log.debug())
                    log.debug('Reseting control ...');

                model.resetControlVal({ ftrId: ftrId, stateId: stateId});
                res.send(model.getVizState());
                res.end();
            } catch (e) {
                log.error(e, 'Failed to reset control!');
                utils.handleServerError(e, req, res);
            }
        });

        app.get(API_PATH + '/controlsSet', function (req, res) {
            try {
                var model = getModel(req.sessionID, req.session);

                if (log.debug())
                    log.debug('Fetching the state of any control features ...');

                res.send({ active: model.getModel().isAnyControlFtrSet() });
                res.end();
            } catch (e) {
                log.error(e, 'Failed to query the state of control features!');
                utils.handleServerError(e, req, res);
            }
        });
    })();
}

function initDataUploadApi() {
    log.info('Initializing data upload API ...');

    var upload = multer({
        storage: multer.memoryStorage(),                // will have file.buffer
        fileFilter: function (req, file, callback) {    // only accept csv files
            var passes = qmutil.stringEndsWith(file.originalname, '.csv');
            log.debug('Filtering uploaded file %s. File passess filter: ' + passes, JSON.stringify(file));
            callback(undefined, passes);
        }
    });

    /* jshint unused: vars */
    app.post('/upload', upload.single('dataset'), function (req, res, next) {
        var sessionId = req.sessionID;
        var session = req.session;

        if (req.file == null) {
            utils.handleServerError(new Error('File not uploaded in the upload request!'), req, res);
            return;
        }

        var fileBuff = req.file.buffer;

        session.datasetName = req.file.originalname;
        fileBuffH[sessionId] = fileBuff;

        var headers = [];
        var attrTypes = [];
        qm.fs.readCsvAsync(fileBuff, { offset: 0, limit: 11 },
            function onBatch(lines) {
                if (lines.length == 0) throw new Error('No lines in the uploaded CSV!');
                var lineArr = lines[0];
                // read the header and create the store
                for (var i = 0; i < lineArr.length; i++) {
                    var name = lineArr[i];

                    // remove double quotes
                    if (name.startsWith('"') && name.endsWith('"'))
                        name = name.substring(1, name.length-1);

                    headers.push({ name: name });
                    attrTypes.push('numeric');
                }

                // try guessing the field types
                for (i = 1; i < lines.length; i++) {
                    var lineV = lines[i];
                    for (var j = 0; j < lineV.length; j++) {
                        var val = lineV[j];

                        if (val == '' || isNaN(val)) {
                            attrTypes[j] = 'categorical';
                        }
                    }
                }

                log.debug('Fields read!');
            },
            function onEnd(e) {
                if (e != null) {
                    log.error(e, 'Exception while reading CSV headers!');
                    utils.handleServerError(e, req, res);
                    return;
                }

                log.debug('Headers read, sending them back to the UI ...');
                if (log.trace())
                    log.trace('Read headers: %s', JSON.stringify(headers));

                session.headerFields = headers;
                res.send({ headers: headers, types: attrTypes });
                res.end();
            });
    });

    function createModel(req, res) {
        try {
            req.connection.setTimeout(LONG_REQUEST_TIMEOUT);    // set long timeout since the processing can take quite long

            var session = req.session;
            var sessionId = req.sessionID;

            var username = session.username;

            var timeAttr = req.body.time;
            var modelName = req.body.name;
            var description = req.body.description;
            var timeUnit = req.body.timeUnit;
            var attrs = req.body.attrs;
            var controlAttrs = req.body.controlAttrs;
            var ignoredAttrs = req.body.ignoredAttrs;
            var isRealTime = req.body.isRealTime;
            var hierarchy = req.body.hierarchyType;
            var clustConfig = req.body.clust;
            var derivAttrs = req.body.derivAttrs;

            var fileBuff = fileBuffH[sessionId];
            var datasetName = session.datasetName;
            var headers = session.headerFields;

            if (fileBuff == null)
                throw new Error('File is not defined while building a new model!');

            delete fileBuffH[sessionId];
            delete session.datasetName;
            delete session.headerFields;

            if (description != null && description.length > 300)
                description = description.substring(0, 300);

            log.debug('Creating a new base for the current user ...');
            var baseDir = utils.getBaseDir(username, new Date().getTime());
            var dbDir = utils.getDbDir(baseDir);

            mkdirp(dbDir, function (e) {
                if (e != null) {
                    log.error(e, 'Failed to create base directory!');
                    utils.handleServerError(e, req, res);
                    return;
                }

                try {
                    // create the store and base, depending on wether the model will be
                    // applied in real-time
                    var storeNm;
                    var userBase;
                    var store;

                    if (isRealTime) {
                        log.debug('Using real-time base and store ...');
                        storeNm = fields.STREAM_STORY_STORE;
                        userBase = base;
                        store = base.store(storeNm);
                    } else {    // not real-time => create a new base and store
                        if (log.debug())
                            log.debug('Creating new base and store ...');

                        var storeFields = [];
                        for (var i = 0; i < attrs.length; i++) {
                            var attr = attrs[i];

                            var fieldConf = {
                                name: attr.name,
                                'null': false
                            };

                            if (attr.type == 'time') {
                                fieldConf.type = 'datetime';
                            } else if (attr.type == 'numeric') {
                                fieldConf.type = 'float';
                            } else if (attr.type == 'nominal') {
                                fieldConf.type = 'string';
                                fieldConf.codebook = true;
                            } else {
                                throw new Error('Invalid attribute type: ' + attr.type);
                            }

                            storeFields.push(fieldConf);
                        }

                        storeNm = config.QM_USER_DEFAULT_STORE_NAME;
                        userBase = new qm.Base({
                            mode: 'create',
                            dbPath: dbDir,
                            strictNames: false
                        });

                        log.debug('Creating default store ...');
                        store = userBase.createStore({
                            name: storeNm,
                            fields: storeFields
                        });
                    }

                    var opts = {
                        username: username,
                        datasetName: datasetName,
                        modelName: modelName,
                        description: description,
                        base: userBase,
                        store: store,
                        storeNm: storeNm,
                        isRealTime: isRealTime,
                        timeUnit: timeUnit,
                        headers: headers,
                        timeAttr: timeAttr,
                        hierarchyType: hierarchy,
                        attrs: attrs,
                        controlAttrs: controlAttrs,
                        ignoredAttrs: ignoredAttrs,
                        fileBuff: fileBuff,
                        clustConfig: clustConfig,
                        baseDir: baseDir,
                        derivAttrs: derivAttrs
                    }

                    // finish the request
                    res.status(204);    // no content
                    res.end();

                    // build the model
                    modelStore.buildModel(opts, function (e, mid, model) {  // TODO check if the user is currently viewing a model before saving the new one to session???
                        if (e != null) {
                            log.error('Exception while building model!');
                            return;
                        }

                        if (isRealTime) {
                            if (log.debug())
                                log.debug('Online model created!');

                            activateModel(model);
                        }
                    });
                } catch (e) {
                    log.error(e, 'Exception while uploading a new dataset!');
                    utils.handleServerError(e, req, res);
                }
            });
        } catch (e) {
            log.error(e, 'Exception while building model!');
            utils.handleServerError(e, req, res);
        }
    }

    function handleGotProgress(req, res, e, isFinished, progress, msg) {
        try {
            var session = req.session;
            var username = session.username;

            if (e != null) {
                log.error(e, 'Failed to build model!');
                modelStore.confirmModelBuilt(username);
                res.send({
                    isFinished: true,
                    progress: 100,
                    message: e.message,
                    error: e.message
                });
            } else if (isFinished) {
                var mid = modelStore.getBuildingModelId(username);
                modelStore.confirmModelBuilt(username);

                res.send({
                    isFinished: true,
                    progress: progress,
                    message: msg,
                    mid: mid
                });
            } else {
                res.send({
                    isFinished: false,
                    message: msg,
                    progress: progress
                });
            }

            res.end();
        } catch (e) {
            log.error(e, 'Failed to send progress to the UI!');
            utils.handleServerError(e, req, res);
        }
    }

    app.get(API_PATH + '/pingProgress', function (req, res) {
        if (log.trace())
            log.trace('Checking model progress ...');

        try {
            var session = req.session;
            var username = session.username;

            if (!modelStore.isBuildingModel(username)) throw new Error('The user is not building a model!');

            if (modelStore.hasProgress(username)) {
                if (log.trace())
                    log.trace('Already have progress, returning result ...');

                var progress = modelStore.popProgress(username);
                handleGotProgress(req, res, progress.error, progress.isFinished, progress.progress, progress.message);
            }
            else {
                var timeoutId = setTimeout(function () {
                    if (log.trace())
                        log.trace('Progress request expired, sending no content ...');

                    if (modelStore.isBuildingModel(username) && modelStore.hasProgress(username))
                        modelStore.clearProgressCallback(username);

                    if (!res.finished) {
                        res.status(204);    // no content
                        res.end();
                    }
                }, 30000);

                modelStore.setProgressCallback(username, function (e, isFinished, progress, message) {
                    if (log.trace())
                        log.trace('Progress callback called ...');

                    clearTimeout(timeoutId);
                    modelStore.clearProgressCallback(username);

                    handleGotProgress(req, res, e, isFinished, progress, message);
                });
            }
        } catch (e) {
            log.error(e, 'Failed to check model progress!');
            utils.handleServerError(e, req, res);
        }
    });

    app.post(API_PATH + '/buildModel', function (req, res) {
        try {
            var session = req.session;
            var username = session.username;

            if (username == null) throw new Error('Username is not defined when building a model!');

            log.debug('Building the model ...');

            // create new base with the default store
            log.debug('Creating users directory ...');
            var userDirNm = utils.getUserDir(username);

            fs.exists(userDirNm, function (exists) {
                if (exists) {
                    log.debug('Reusing directory %s ...', userDirNm);
                    createModel(req, res);
                } else {
                    fs.mkdir(userDirNm, function (e) {
                        if (e != null) {
                            log.error(e, 'Failed to create directory!');
                            utils.handleServerError(e, req, res);
                            return;
                        }
                        createModel(req, res);
                    });
                }
            });
        } catch (e) {
            log.error(e, 'Exception while creating user directory!');
            utils.handleServerError(e, req, res);
        }
    });

    app.post(API_PATH + '/selectDataset', function (req, res) {
        var session = req.session;
        var sessionId = req.sessionID;
        var username = session.username;

        var modelId = req.body.modelId;

        if (log.debug())
            log.debug('User %s selected model %s ...', username, modelId);

        db.fetchModel(modelId, function (e, modelConfig) {
            if (e != null) {
                log.error(e, 'Failed to get base info for user: %s', username);
                utils.handleServerError(e, req, res);
                return;
            }

            try {
                var fname;
                if (modelConfig.is_realtime == 1) {
                    fname = modelConfig.model_file;
                    var isActive = modelConfig.is_active == 1;

                    if (isActive) {
                        if (log.debug())
                            log.debug('Adding an already active model to the session ...');

                        var model = modelStore.getModel(modelId);
                        saveToSession(sessionId, session, base, model, modelId, fname);
                        res.status(204);    // no content
                        res.end();
                    } else {
                        if (log.debug())
                            log.debug('Adding an inactive model to the session ...');

                        modelStore.loadOnlineModel(modelConfig.model_file, function (e, model) {
                            if (e != null) {
                                log.error(e, 'Exception while loading online model!');
                                utils.handleServerError(e, req, res);
                                return;
                            }

                            saveToSession(sessionId, session, base, model, modelId, fname);
                            res.status(204);    // no content
                            res.end();
                        });
                    }
                } else {
                    fname = utils.getModelFName(modelConfig.base_dir);

                    modelStore.loadOfflineModel(modelConfig.base_dir, function (e, baseConfig) {
                        if (e != null) {
                            log.error(e, 'Exception while loading offline model!');
                            utils.handleServerError(e, req, res);
                            return;
                        }

                        saveToSession(sessionId, session, baseConfig.base, baseConfig.model, modelId, fname);
                        res.status(204);    // no content
                        res.end();
                    });
                }
            } catch (e1) {
                log.error(e1, 'Failed to initialize model!');
                utils.handleServerError(e1, req, res);
            }
        });
    });
}

function initServerApi() {
    log.info('Initializing general server REST API ...');

    {
        log.debug('Registering exit service ...');
        app.get(API_PATH + '/exit', function (req, res) {
            try {
                log.info(API_PATH + '/exit called. Exiting qminer and closing server ...');
                utils.exit(base);
                res.status(204);
                res.end();
            } catch (e) {
                log.error(e, 'Failed to exit!');
                utils.handleServerError(e, req, res);
            }
        });
    }

    {
        app.get(API_PATH + '/theme', function (req, res) {
            try {
                var session = req.session;
                res.send({ theme: session.theme });
                res.end();
            } catch (e) {
                log.error(e, 'Failed fetch theme!');
                utils.handleServerError(e, req, res);
            }
        });

        app.post(API_PATH + '/theme', function (req, res) {
            try {
                var session = req.session;
                var username = session.username;

                var theme = req.body.theme;

                db.updateTheme(username, theme, function (e) {
                    if (e != null) {
                        log.error(e, 'Exception while setting theme!');
                        utils.handleServerError(e, req, res);
                        return;
                    }

                    session.theme = theme;
                    res.status(204);
                    res.end();
                });
            } catch (e) {
                log.error(e, 'Failed to set theme!');
                utils.handleServerError(e, req, res);
            }
        });
    }

    (function () {
        log.debug('Registering push data service ...');

        var batchN = 0;

        app.post(DATA_PATH + '/push', function (req, res) {
            var batch = req.body;

            try {
                if (batchN == 1) {
                    throughput.init();
                }

                for (var i = 0; i < batch.length; i++) {
                    addRawMeasurement(batch[i]);
                }

                if (batchN >= 1) {
                    throughput.update(batch.length);
                    if (batchN % 100 == 0) {
                        throughput.print();
                    }
                }

                batchN++;

                res.status(204);
                res.end();
            } catch (e) {
                log.error(e, 'Failed to process raw measurement!');
                utils.handleServerError(e, req, res);
            }
        });
    })();

    {
        log.debug('Registering count active models service ...');    // TODO remove after doing it with EJS
        app.get(API_PATH + '/countActiveModels', function (req, res) {
            log.debug('Fetching the number of active models from the DB ...');

            db.countActiveModels(function (e, result) {
                if (e != null) {
                    log.error(e, 'Failed to count the number of active models!');
                    utils.handleServerError(e, req, res);
                    return;
                }

                res.send(result);
                res.end();
            });
        });
    }

    (function () {
        log.debug('Registering activate model service ...');

        function activateModelById(req, res, modelId, activate, isFromUi) {
            if (log.debug())
                log.debug('Activating model %s: ' + activate, modelId);

            var session = req.session;

            db.activateModel({modelId: modelId, activate: activate}, function (e1) {
                if (e1 != null) {
                    log.error(e1, 'Failed to activate model %s!', modelId);
                    utils.handleServerError(e1, req, res);
                    return;
                }

                try {
                    if (activate) {
                        db.fetchModel(modelId, function (e2, modelConfig) {
                            if (e2 != null) {
                                log.error(e2, 'Failed to fetch a model from the DB!');
                                utils.handleServerError(e2, req, res);
                                return;
                            }

                            modelStore.loadOnlineModel(modelConfig.model_file, function (e, model) {
                                if (e != null) {
                                    log.error(e, 'Exception while loading online model!');
                                    return;
                                }

                                if (log.debug())
                                    log.debug('Activating model with id %s', model.getId());

                                if (isFromUi) {
                                    //                                  var currModel = getModel(sessionId, session);
                                    //                                  deactivateModel(currModel);
                                    session.model = model;
                                }

                                activateModel(model);

                                res.status(204);
                                res.end();
                            });
                        });
                    } else {
                        // deactivate, the model is currently active
                        var model = modelStore.getModel(modelId);
                        deactivateModel(model);

                        res.status(204);
                        res.end();
                    }
                } catch (e2) {
                    log.error(e2, 'Model activated in the DB, but failed to activate it in the app!');
                    utils.handleServerError(e2, req, res);
                }
            });
        }

        app.post(API_PATH + '/removeModel', function (req, res) {
            try {
                var modelId = req.body.modelId;

                log.debug('Removing model %d', modelId);

                db.deleteModel(modelId, function (e) {
                    if (e != null) {
                        return utils.handleServerError(e, req, res);
                    }

                    res.status(204);
                    res.end();
                });
            } catch (e) {
                log.error(e, 'Failed to process raw measurement!');
                utils.handleServerError(e, req, res);
            }
        });

        app.post(API_PATH + '/activateModel', function (req, res) {
            try {
                var modelId = req.body.modelId;
                var activate = req.body.activate;

                if (activate == null) throw new Error('Missing parameter activate!');
                if (modelId == null) throw new Error('WTF?! Tried to activate a model that doesn\'t have an ID!');

                activateModelById(req, res, modelId, activate, false);
            } catch (e) {
                log.error(e, 'Failed to process raw measurement!');
                utils.handleServerError(e, req, res);
            }
        });

        app.post(API_PATH + '/activateModelViz', function (req, res) {
            try {
                var session = req.session;
                var activate = req.body.activate == 'true';

                if (activate == null) throw new Error('Missing parameter activate!');

                var model = getModel(req.sessionID, session);

                activateModelById(req, res, model.getId(), activate, true);
            } catch (e) {
                log.error(e, 'Failed to process raw measurement!');
                utils.handleServerError(e, req, res);
            }
        });
    })();

    (function () {
        log.debug('Registering model mode service ...');
        app.get(API_PATH + '/modelMode', function (req, res) {
            log.debug('Fetching model mode from the db DB ...');

            var model = getModel(req.sessionID, req.session);

            db.fetchModel(model.getId(), function (e, modelConfig) {
                if (e != null) {
                    log.error(e, 'Failed to get model mode from the DB!');
                    utils.handleServerError(e, req, res);
                    return;
                }

                res.send({
                    isRealtime: modelConfig.is_realtime == 1,
                    isActive: modelConfig.is_active == 1
                });
                res.end();
            });
        });
    })();

    app.post(API_PATH + '/shareModel', function (req, res) {
        try {
            var mid = req.body.modelId;
            var share = req.body.share;

            if (log.debug())
                log.debug('Sharing model %s: ', mid);

            db.makeModelPublic(mid, share, function (e) {
                if (e != null) {
                    log.error(e, 'Failed to activate model %s!', mid);
                    utils.handleServerError(e, req, res);
                    return;
                }

                res.status(204);
                res.end();
            });
        } catch (e) {
            log.error(e, 'Failed to process raw measurement!');
            utils.handleServerError(e, req, res);
        }
    });
}

function initConfigRestApi() {
    log.info('Initializing configuration REST API ...');

    app.get(API_PATH + '/config', function (req, res) {
        try {
            var properties = req.query.properties;

            if (log.debug())
                log.debug('Fetching property %s', JSON.stringify(properties));

            log.debug('Fetching intensities from DB ...');
            db.getMultipleConfig({properties: properties}, function (e, result) {
                if (e != null) {
                    log.error(e, 'Failed to fetch properties from DB!');
                    utils.handleServerError(e, req, res);
                    return;
                }

                res.send(result);
                res.end();
            });
        } catch (e) {
            log.error(e, 'Failed to query configuration!');
            utils.handleServerError(e, req, res);
        }
    });

    app.post(API_PATH + '/config', function (req, res) {
        try {
            var config = req.body;

            if (log.debug())
                log.debug('Setting configuration %s', JSON.stringify(config));

            db.setConfig(config, function (e) {
                if (e != null) {
                    log.error(e, 'Failed to update settings!');
                    utils.handleServerError(e, req, res);
                    return;
                }

                if ('calc_coeff' in config) {
                    if (log.debug())
                        log.debug('Found calc_coeff in the new configuration. Setting ...')
                    pipeline.setCalcCoeff(config.calc_coeff == 'true');
                }

                res.status(204);    // no content
                res.end();
            });
        } catch (e) {
            log.error(e, 'Failed to set configuration!');
            utils.handleServerError(e, req, res);
        }
    });
}

function initMessageRestApi() {
    app.get(API_PATH + '/modelMessages', function (req, res) {
        try {
            var limit = req.query.limit;
            var model = getModel(req.sessionID, req.session);

            if (limit != null) limit = parseInt(limit);

            modelManager.getLatestMessages(model, limit, function (e, messages) {
                if (e != null) {
                    utils.handleServerError(e, req, res);
                    return;
                }

                res.send(messages);
                res.end();
            })
        } catch (e) {
            log.error(e, 'Failed to query configuration!');
            utils.handleServerError(e, req, res);
        }
    });

    app.get(API_PATH + '/modelMessagesCount', function (req, res) {
        try {
            var model = getModel(req.sessionID, req.session);
            modelManager.countMessages(model, function (e, count) {
                if (e != null) {
                    utils.handleServerError(e, req, res);
                    return;
                }

                res.send({ count: count });
                res.end();
            })
        } catch (e) {
            log.error(e, 'Failed to query configuration!');
            utils.handleServerError(e, req, res);
        }
    });
}

function initBroker() {
    broker.init();

    log.info('Initializing broker callbacks ...');

    var imported = 0;
    var printInterval = 100;

    var lastCepTime = 0;

    var enrichedFields = [  // FIXME remove this
        {"name": "time", "type": "datetime"},
        {"name": "hook_load", "type": "float"},
        {"name": "hoist_press_A", "type": "float"},
        {"name": "hoist_press_B", "type": "float"},
        {"name": "ibop", "type": "float"},
        // friction
        {"name": "oil_temp_gearbox", "type": "float"},
        {"name": "oil_temp_swivel", "type": "float"},
        {"name": "pressure_gearbox", "type": "float"},
        {"name": "rpm", "type": "float"},
        {"name": "temp_ambient", "type": "float"},
        {"name": "torque", "type": "float"},
        {"name": "wob", "type": "float"},
        // setpoint
        {"name": "mru_pos", "type": "float"},
        {"name": "mru_vel", "type": "float"},
        {"name": "ram_pos_measured", "type": "float"},
        {"name": "ram_pos_setpoint", "type": "float"},
        {"name": "ram_vel_measured", "type": "float"},
        {"name": "ram_vel_setpoint", "type": "float"},
        // activity recognition
        {"name": "slips_closed", "type": "float"},
        {"name": "slips_closing", "type": "float"},
        {"name": "slips_open", "type": "float"},
        {"name": "slips_opening", "type": "float"},
        // new use case
        { "name" : "upper_clamp", "type": "float" },
        { "name" : "lower_clamp", "type": "float" },
        { "name" : "tr_rot_makeup", "type": "float" },
        { "name" : "tr_rot_breakout", "type": "float" },
        { "name" : "hrn_travel_pos", "type": "float" },
        { "name" : "travel_forward", "type": "float" },
        { "name" : "travel_backward", "type": "float" },
        { "name" : "hrn_travel_valve", "type": "float" },
        { "name" : "hrn_spinning_out", "type": "float" },
        { "name" : "hrn_spinner_clamp_closed", "type": "float" },
        { "name" : "hrn_elevation", "type": "float" },
        { "name" : "hrn_elevation_up_down", "type": "float" },
        { "name" : "hrn_elevate_up", "type": "float" },
        { "name" : "hrn_elevate_down", "type": "float" },
        { "name" : "brc_load", "type": "float" },
        { "name" : "brc_fwd_travel_valve", "type": "float" },
        { "name" : "brc_travel_pos_fleg", "type": "float" },
        { "name" : "brc_travel_valve", "type": "float" },
        { "name" : "brc_travel_pos", "type": "float" },
        { "name" : "brc_grip_upper_valve", "type": "float" },
        { "name" : "brc_grip_lower_valve", "type": "float" },
        { "name" : "brc_lift_valve", "type": "float" },
        { "name" : "brc_standlift_pos", "type": "float" }
    ];

    broker.onMessage(function (msg) {
        try {
            var val;
            if (msg.type == 'raw') {
                if (++imported % printInterval == 0 && log.trace())
                    log.trace('Imported %d values ...', imported);
                var payload = msg.payload;


                if (log.trace())
                    log.trace('Received raw measurement: %s', JSON.stringify(payload));

                //              //========================================================
                //              // TODO remove this
                //              payload = transform.parseDominiksRawEvent(msg);
                //              //========================================================

                addRawMeasurement(payload);
            }
            else if (msg.type == 'enriched') {
                val = msg.payload;

                if (val.timestamp == null) {
                    val.timestamp = val.time;
                    delete val.time;
                }

                val.time = utils.dateToQmDate(new Date(val.timestamp));
                delete val.timestamp;

                for (var i = 0; i < enrichedFields.length; i++) {   // FIXME remove this
                    if (!(enrichedFields[i].name in val))
                        val[enrichedFields[i].name] = 0;
                }

                if (log.trace())
                    log.trace('Got enriched event ...');

                base.store(fields.OA_IN_STORE).push(val);
            }
            else if (msg.type == 'cep') {
                if (log.trace())
                    log.trace('Received CEP message: %s', JSON.stringify(msg));

                var event = msg.payload;

                //              //========================================================
                //              // TODO remove this
                //              event = transform.parseDominiksDerivedEvent(event);
                //              //========================================================

                val = transform.parseDerivedEvent(event);

                var timestamp = event.timestamp;
                var eventName = event.eventName;

                var predMsg = null;
                if (isNaN(timestamp)) {
                    log.warn('CEP sent NaN time %s', JSON.stringify(val));
                    return;
                }
                else if (timestamp <= lastCepTime) {
                    log.warn('CEP sent invalid time %d <= %d: %s', timestamp, lastCepTime, JSON.stringify(val));
                    return;
                }

                if (eventName == 'Generated') {
                    if (log.trace())
                        log.trace('Got enriched event ...');

                    base.store(fields.OA_IN_STORE).push(val);
                } else if (eventName == 'timeToMolding') {
                    if (log.trace())
                        log.trace('Processing %s event ...', eventName);

                    var ll = val.lacqueringLineId;
                    var mm = val.mouldingMachineId;
                    // var shuttleId = val.shuttleId;
                    var deltaTm = val.timeDifference;

                    var minTime = transform.getMinShuttleTime(ll, mm);

                    if (log.debug())
                        log.debug('Got %s event, minTime: %s ...', eventName, minTime);

                    if (minTime != null) {
                        var timeRatio = deltaTm / minTime;

                        if (log.debug())
                            log.debug('Calculated timeToMolding ratio: %d', timeRatio);

                        if (timeRatio < 1.2) {
                            predMsg = {
                                type: 'prediction',
                                content: {
                                    time: timestamp,
                                    eventId: 'Moulding line empty: ' + mm,
                                    pdf: {
                                        type: 'exponential',
                                        lambda: 1000
                                    }
                                }
                            };

                            if (log.debug())
                                log.debug('Sending prediction %s', JSON.stringify(predMsg));

                            sendPrediction(predMsg, timestamp);
                        }
                    }
                } else {
                    if (log.debug())
                        log.debug('Got unknown event, sending prediction ...');
                    // send prediction directly

                    predMsg = {
                        type: 'prediction',
                        content: {
                            time: timestamp,
                            eventId: 'Some dummy prediction generated from a CEP event',
                            pdf: {
                                type: 'exponential',
                                lambda: 1
                            }
                        }
                    };

                    sendPrediction(predMsg, timestamp);
                }

                lastCepTime = timestamp;
            } else {
                log.warn('Invalid message type: %s', msg.type);
            }
        } catch (e) {
            log.error(e, 'Exception while processing broker message!');
        }
    });
}

function loadSaveModels() {
    db.fetchAllModels(function (e, models) {
        if (e != null) {
            log.error(e, 'Failed to fetch all models for saving!');
            return;
        }

        if (log.debug())
            log.debug('There is a total of %d models ...', models.length);

        for (var i = 0; i < models.length; i++) {
            log.debug('Resaving model %s', JSON.stringify(models[i]));
            modelStore.loadSaveModel(models[i]);
        }
    });
}

function loadActiveModels() {
    log.info('Loading active models ...');

    db.fetchActiveModels(function (e, models) {
        if (e != null) {
            log.error(e, 'Failed to load active models!');
            return;
        }

        if (log.debug())
            log.debug('There are %d active models on startup ...', models.length);

        var loadCb = function (e, model) {
            if (e != null) {
                log.error(e, 'Exception while loading online model!');
                return;
            }

            if (log.debug())
                log.debug('Activating model with id %s', model.getId());

            activateModel(model);
        }

        for (var i = 0; i < models.length; i++) {
            var modelConfig = models[i];

            try {
                if (log.debug())
                    log.debug('Initializing model %s ...', JSON.stringify(modelConfig));

                modelStore.loadOnlineModel(modelConfig.model_file, loadCb);
            } catch (e1) {
                log.error(e1, 'Exception while initializing model %s', JSON.stringify(modelConfig));
            }
        }
    });
}

function excludeDirs(dirs, middleware) {
    function isInDirs(path) {
        for (var i = 0; i < dirs.length; i++) {
            if (path.startsWith(dirs[i]))
                return true;
        }
        return false;
    }

    return function (req, res, next) {
        var path = req.path;
        if (log.trace())
            log.trace('Request to path %s', path);

        if (isInDirs(path)) {
            if (log.trace())
                log.trace('Will not use middleware!')
            return next();
        } else {
            if (log.trace())
                log.trace('Will use middleware!')
            return middleware(req, res, next);
        }
    }
}

function excludeFiles(files, middleware) {
    return function (req, res, next) {
        var path = req.path;

        if (path == '/') path = '/index.html';

        if (log.trace())
            log.trace('Request to path %s', path);

        var isExcluded = false;

        for (var i = 0; i < files.length; i++) {
            var fname = files[i];
            if (path.endsWith(fname)) {
                isExcluded = true;
            }
        }

        if (isExcluded) {
            if (log.trace())
                log.trace('Will not use middleware!')
            return next();
        } else {
            if (log.trace())
                log.trace('Will use middleware!')
            return middleware(req, res, next);
        }
    }
}

function getPageOpts(req, next) {
    void next;

    var session = req.session;
    var page = getRequestedPage(req);

    var opts = {
        utils: utils,
        username: null,
        theme: session.theme,
        model: session.model,
        modelConfig: null,
        models: null,
        modelStore: modelStore,
        error: null,
        warning: null,
        message: null,
        page: page,
        subtitle: titles[page],
        useCase: config.USE_CASE_NAME
    };

    if (isLoggedIn(session)) {
        opts.username = session.username;
    }

    if (session.error != null) {
        opts.error = session.error;
        delete session.error;
    }

    if (session.warning != null) {
        opts.warning = session.warning;
        delete session.warning;
    }

    if (session.message != null) {
        opts.message = session.message;
        delete session.message;
    }

    // add the options necessary for external authentication
    externalAuth.prepDashboard(opts);

    return opts;
}

function prepPage(page) {
    return function(req, res) {
        res.render(page, getPageOpts(req, res));
    }
}

function addUseCaseOpts(opts, callback) {
    if (config.USE_CASE == config.USE_CASE_MHWIRTH) {
        var properties = [
            'calc_coeff',
            'deviation_extreme_lambda',
            'deviation_major_lambda',
            'deviation_minor_lambda',
            'deviation_significant_lambda'
        ];

        db.getMultipleConfig({properties: properties}, function (e, result) {
            if (e != null) {
                log.error(e, 'Failed to fetch properties from DB!');
                callback(e);
                return;
            }

            var props = {};
            for (var i = 0; i < result.length; i++) {
                props[result[i].property] = result[i].value;
            }

            opts.config = props;

            callback(undefined, opts);
        });
    } else {
        callback(undefined, opts);
    }
}

function prepDashboard() {
    return function (req, res) {
        var opts = getPageOpts(req, res);
        var session = req.session;

        var username = session.username;

        db.fetchUserModels(username, function (e, dbModels) {
            if (e != null) {
                log.error(e, 'Failed to fetch user models!');
                utils.handleServerError(e, req, res);
                return;
            }

            var models = {
                online: {
                    active: [],
                    inactive: [],
                },
                offline: [],
                publicModels: []
            };
            for (var i = 0; i < dbModels.length; i++) {
                var model = dbModels[i];

                var isOnline = model.is_active != null;
                var isPublic = model.is_public == 1;

                if (isPublic) {
                    models.publicModels.push(model);
                }
                else if (isOnline) {
                    if (model.is_active == 1) {
                        models.online.active.push(model);
                    } else {
                        models.online.inactive.push(model);
                    }
                }
                else {
                    models.offline.push(model);
                }
            }

            addUseCaseOpts(opts, function (e, opts) {
                if (e != null) {
                    utils.handleServerError(e, req, res);
                    return;
                }
                opts.models = models;
                res.render('dashboard', opts);
            });
        });
    }
}

function prepMainUi() {
    return function (req, res) {
        var opts = getPageOpts(req, res);
        var session = req.session;

        var model = session.model;

        opts.MEAN_STATE_LABEL = config.MEAN_STATE_LABEL;

        db.fetchModel(model.getId(), function (e, modelConfig) {
            if (e != null) {
                log.error(e, 'Failed to fetch model configuration from the DB!');
                utils.handleServerError(e, req, res);
                return;
            }

            opts.modelConfig = modelConfig;

            if (model.isOnline()) {
                opts.predictionThreshold = model.getModel().getParam('predictionThreshold');
                opts.timeHorizon = model.getModel().getParam('timeHorizon');
                opts.pdfBins = model.getModel().getParam('pdfBins');

                async.parallel([
                    function (xcb) {
                        modelManager.countTotalActive(xcb);
                    },
                    function (xcb) {
                        modelManager.getLatestMessages(model, 10, xcb);
                    }
                ], function (e, results) {
                    if (e != null) {
                        log.error(e, 'Failed to pred page for an online model!');
                        utils.handleServerError(e, req, res);
                        return;
                    }

                    var activeCount = results[0];
                    var messages = results[1];

                    opts.activeModelCount = activeCount;
                    opts.messages = messages;

                    res.render('ui', opts);
                })
            } else {
                res.render('ui', opts);
            }
        });
    }
}

function accessControl(req, res, next) {
    var session = req.session;
    // if using external authentication, then do not use access
    // control
    if (config.AUTHENTICATION_EXTERNAL) {
        var token = req.query.token;

        if (token == null) return next();

        var fetchCredentials = function () {
            externalAuth.fetchCredentials(token, function (e, user) {
                if (e != null) return utils.handleServerError(e, req, res);

                loginUser(session, {
                    username: user.email,
                    theme: user.theme
                });

                session[FZI_TOKEN_KEY] = token;

                next();
            })
        }

        if (isLoggedIn(session)) {
            if (session[FZI_TOKEN_KEY] != token) {
                // fetch user credentials from the authentication system
                fetchCredentials();
            } else {
                return next();
            }
        } else {
            // fetch user credentials from the authentication system
            fetchCredentials();
        }
    }
    else {
        var page = getRequestedPage(req);
        var dir = getRequestedPath(req);

        // if the user is not logged in => redirect them to login
        // login is exempted from the access control
        if (!isLoggedIn(session)) {
            if (log.debug())
                log.debug('Session data missing for page %s, dir %s ...', page, dir);

            var isAjax = req.xhr;
            if (isAjax) {
                if (log.debug())
                    log.debug('Session data missing for AJAX API call, blocking!');
                utils.handleNoPermission(req, res);
            } else {
                redirect(res, 'login.html');
            }
        } else {
            next();
        }
    }
}

function getHackedSessionStore() {
    var store =  new SessionStore();
    store.on('preDestroy', function (sessionId, session) {
        cleanUpSessionModel(sessionId, session);
        if (sessionId in fileBuffH)
            delete fileBuffH[sessionId];
    });
    return store;
}

function initServer(sessionStore, parseCookie) {
    log.info('Initializing web server ...');

    var sess = session({
        unset: 'destroy',
        store: sessionStore,
        cookie: { maxAge: 1000*60*60*24 },  // the cookie will last for 1 day
        resave: true,
        saveUninitialized: true
    });

    // the paths which will be excluded from the session
    var sessionExcludePaths = (function () {
        var paths = [ DATA_PATH ];
        if (config.USE_BROKER) {
            paths.push(fzi.STRAM_PIPES_PATHS);
        }
        return paths
    })();

    app.set('view engine', 'ejs');
    app.use(parseCookie);
    app.use(excludeDirs(sessionExcludePaths, sess));
    // automatically parse body on the API path
    app.use(LOGIN_PATH + '/', bodyParser.urlencoded({ extended: false, limit: '50Mb' }));
    app.use(LOGIN_PATH + '/', bodyParser.json({limit: '50Mb'}));
    app.use(API_PATH + '/', bodyParser.urlencoded({ extended: false, limit: '50Mb' }));
    app.use(API_PATH + '/', bodyParser.json({limit: '50Mb'}));
    app.use(DATA_PATH + '/', bodyParser.json({limit: '50Mb'}));
    app.use(fzi.STREAM_PIPES_PATH + '/', bodyParser.json({limit: '50Mb'}));
    app.use(fzi.STREAM_PIPES_PATH + '/', bodyParser.urlencoded({ extended: false, limit: '50Mb' }));

    // when a session expires, redirect to index
    app.use('/ui.html', function (req, res, next) {
        var model = getModel(req.sessionID, req.session);
        // check if we need to redirect to the index page
        if (model == null) {
            log.debug('Session data missing, redirecting to index ...');
            res.redirect('dashboard.html');
        } else {
            next();
        }
    });

    initLoginRestApi();
    initServerApi();
    initStreamStoryRestApi();
    initConfigRestApi();
    initMessageRestApi();
    initDataUploadApi();

    //==============================================
    // INTEGRATION
    if (config.USE_BROKER) {
        fzi.initWs(app);
    }
    //==============================================

    var sessionExcludeDirs = [
        '/login',
        '/js',
        '/css',
        '/img',
        '/lib',
        '/popups',
        '/material',
        '/landing',
        '/streampipes',
        '/data'
    ];
    var sessionExcludeFiles = [
        'index.html',
        'login.html',
        'register.html',
        'resetpassword.html'
    ];

    app.use(excludeDirs(sessionExcludeDirs, excludeFiles(sessionExcludeFiles, accessControl)));

    // the index page
    app.get('/', prepPage('landing'));
    app.get('/index.html', prepPage('landing'));
    // the other pages
    app.get('/login.html', prepPage('login'));
    app.get('/register.html', prepPage('register'));
    app.get('/resetpassword.html', prepPage('resetpassword'));
    app.get('/profile.html', prepPage('profile'));
    app.get('/dashboard.html', prepDashboard('dashboard'));
    app.get('/ui.html', prepMainUi('ui'));

    // serve static directories on the UI path
    app.use(UI_PATH, express.static(path.join(__dirname, '../ui')));

    // start server
    var server = app.listen(config.SERVER_PORT);

    log.info('================================================');
    log.info('Server running at http://localhost:%d', config.SERVER_PORT);
    log.info('Serving UI at: %s', UI_PATH);
    log.info('Serving API at: %s', API_PATH);
    log.info('Data API: %s', DATA_PATH);
    log.info('Web socket listening at: %s', WS_PATH);
    log.info('================================================');

    return server;
}

exports.init = function (opts) {
    log.info('Initializing server ...');

    base = opts.base;
    db = opts.db;
    pipeline = opts.pipeline;

    var sessionStore = getHackedSessionStore();
    var parseCookie = cookieParser('somesecret_TODO make config');

    // serve static files at www
    var server = initServer(sessionStore, parseCookie);

    var ws = WebSocketWrapper({
        server: server,
        sessionStore: sessionStore,
        parseCookie: parseCookie,
        webSocketPath: WS_PATH,
        onConnected: function (socketId, sessionId, session) {
            try {
                var model = getModel(sessionId, session);

                if (model.getId() == null)
                    log.warn('Model ID not set when opening a new web socket connection!');
                if (model.isActive())
                    modelStore.addWebSocketId(model.getId(), socketId);
            } catch (e) {
                log.error(e, 'Exception on web socket connection callback!');
            }
        },
        onDisconnected: function (socketId) {
            if (log.debug())
                log.debug('Socket %d disconnected, removing from model store ...', socketId);
            modelStore.removeWebSocketId(socketId);
        }
    });

    modelStore = ModelStore({
        base: base,
        ws: ws,
        db: db,
        onAdd: function (model) {
            if (log.debug())
                log.debug('Model %s added to the model store, activating handlers ...', model.getId());

        },
        onRemove: function (model) {
            if (log.debug())
                log.debug('Model %s removed from the model store! Deactivating handlers ...', model.getId());
        }
    });

    modelManager = new ssmodules.ModelManager({
        db: db,
        modelStore: modelStore
    })

    loadSaveModels();
    loadActiveModels();
    initPipelineHandlers();
    initBroker();

    if (config.USE_BROKER) {
        fzi.init({
            broker: broker,
            modelStore: modelStore,
            db: db
        });
    }

    log.info('Done!');

    if (config.AUTHENTICATION_EXTERNAL) {
        externalAuth.setDb(db);
    }
};
