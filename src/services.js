var express = require('express');
var bodyParser = require("body-parser");
var path = require('path');
var fs = require('fs');
var math = require('mathjs');
var mkdirp = require('mkdirp');
var multer = require('multer');
var session = require('express-session');
var cookieParser = require('cookie-parser');

var SessionStore = require('./util/sessionstore.js');
var utils = require('./utils.js');
var broker = require('./broker.js');
var config = require('../config.js');
var fields = require('../fields.js');

var ModelStore = require('./util/servicesutil.js').RealTimeModelStore;
var WebSocketWrapper = require('./util/servicesutil.js').WebSocketWrapper;

var qmutil = qm.qm_util;

var UI_PATH = '/';
var API_PATH = '/api';
var WS_PATH = '/ws';

var app = express();

var hmc;	// TODO remove hmc
var base;
var db;
var pipeline;
var modelStore;

var counts = {};
var storeLastTm = {};
var totalCounts = 0;

var lastCepTime = 0;
var lastRawTime = 0;

var intensConfig = {};

function getModel(sessionId, session) {
	return session.model;
}

function setNewModel(modelId, model) {
	try {
		log.info('Adding a new online model ...');
		modelStore.add(modelId, model);
	} catch (e) {
		log.error(e, 'Failed to set a new real-time model!');
	}
}

function saveToSession(session, username, userBase, model, userConfig) {
	log.debug('Saving new data to session ...');
	if (session.base != null)
		cleanUpSession(session);
	session.username = username;
	session.base = userBase;
	session.model = model;
}

function cleanUpSession(session) {
	if (log.debug())
		log.debug('Cleaning up session ...');
	
	if (session.base != null) {
		if (session.base == base) {
			log.debug('Will not close base as it is the real-time base ...');
		} else {
			log.debug('Closing base for user %s ...', session.username);
			session.base.close();
			log.debug('Base closed!');
		}
	}
	
	delete session.username;
	delete session.base;
	delete session.model;
}

function addRawMeasurement(val) {
	var storeNm = utils.storeFromTag(val.variable_type);
	
	if (!(storeNm in counts)) counts[storeNm] = 0;
	if (!(storeNm in storeLastTm)) storeLastTm[storeNm] = 0;
	
	counts[storeNm]++;
	
	if (totalCounts++ % config.RAW_PRINT_INTERVAL == 0)
		log.debug('Time: %s, Counts: %s', new Date(val.variable_timestamp).toString(), JSON.stringify(counts));
	
	var timestamp = val.variable_timestamp;
	var prevTimestamp = storeLastTm[storeNm];
	
	if (timestamp <= prevTimestamp)
		throw 'Invalid time for a single measurement! Current: ' + timestamp + ', prev: ' + prevTimestamp;
	if (timestamp < lastRawTime)
		throw 'Invalid time! Current: ' + timestamp + ', prev: ' + lastRawTime;
	
	var insertVal = {
		time_ms: timestamp,
		time: utils.dateToQmDate(new Date(timestamp)),
		value: val.value
	};

	base.store(storeNm).push(insertVal);
	storeLastTm[storeNm] = timestamp;
	lastRawTime = timestamp;
}

function addCepAnnotated(val) {	
	var time = val.time;
	
	if (isNaN(time)) {
		log.warn('CEP sent NaN time %s', JSON.stringify(val));
	} 
	else if (time <= lastCepTime) {
		log.warn('CEP sent invalid time %d <= %d: %s', time, lastCepTime, JSON.stringify(val));
		return;
	}
	
	val.time = utils.dateToQmDate(new Date(val.time));
	base.store(fields.OA_IN_STORE).push(val);
	
	lastCepTime = time;
}

function initRestApi() {
	log.info('Registering REST services ...');
	
	{
		log.info('Registering exit service ...');
		
		// multilevel analysis
		app.get(API_PATH + '/exit', function (req, resp) {
			try {
				log.info(API_PATH + '/exit called. Exiting qminer and closing server ...');
				utils.exit(base);
				resp.status(204);
			} catch (e) {
				log.error(e, 'Failed to exit!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		log.info('Registering save service ...');
		
		// multilevel analysis
		app.get(API_PATH + '/save', function (req, resp) {
			try {
				var model = getModel(req.sessionID, req.session);
				model.save(config.STREAM_STORY_FNAME);	// TODO change the file name
				resp.status(204);
			} catch (e) {
				log.error(e, 'Failed to save visualization model!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
	}
	
	{
		log.info('Registering push data service ...');
		
		var imported = 0;
		var printInterval = 10000;
		
		app.post(API_PATH + '/push', function (req, resp) {
			var batch = req.body;
			
			try {
				for (var i = 0; i < batch.length; i++) {
					var instance = batch[i];
					
					if (++imported % printInterval == 0 && log.trace())
						log.trace('Imported %d values ...', imported);
					
					addRawMeasurement(instance);
				}
				
				resp.status(204);
				resp.end();
			} catch (e) {
				log.error(e, 'Failed to process raw measurement!');
				resp.status(500);
				resp.end();
			}
		});
	}
	
	{
		log.info('Registering set parameter service ...');
		
		app.post(API_PATH + '/param', function (req, resp) {
			try {
				var paramName = req.body.paramName;
				var paramVal = parseFloat(req.body.paramVal);
				
				var model = getModel(req.sessionID, req.session);
				
				var paramObj = {};
				paramObj[paramName] = paramVal;
				
				model.getModel().setParams(paramObj);
				resp.status(204);	// no content
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		app.get(API_PATH + '/param', function (req, resp) {
			try {
				var param = req.query.paramName;
				var model = getModel(req.sessionID, req.session);
				
				var val = model.getModel().getParam(param);
				resp.send({ parameter: param, value: val });
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		app.get(API_PATH + '/timeUnit', function (req, resp) {
			try {
				var model = getModel(req.sessionID, req.session);
				resp.send({ value: model.getModel().getTimeUnit() });
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			resp.end();
		});
	}
	
	{
		log.info('Registering multilevel service at drilling/multilevel ...');
		
		// multilevel analysis
		app.get(API_PATH + '/multilevel', function (req, resp) {
			try {
				var model = getModel(req.sessionID, req.session);
				
				log.debug('Querying MHWirth multilevel model ...');
				resp.send(model.getVizState());
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		// multilevel analysis
		app.get(API_PATH + '/features', function (req, resp) {
			try {
				var model = getModel(req.sessionID, req.session);
				log.debug('Fetching all the features ...');
				resp.send(model.getFtrDesc());
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
	}
	
	{
		log.info('Registering transition model service ...');
		
		// multilevel analysis
		app.get(API_PATH + '/transitionModel', function (req, resp) {
			try {
				var level = parseFloat(req.query.level);
				var model = getModel(req.sessionID, req.session);
				
				if (log.debug())
					log.debug('Fetching transition model for level: %.3f', level);
				
				resp.send(model.getModel().getTransitionModel(level));
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
	}
	
	{
		log.info('Registering future and states services ...');
		
		// multilevel analysis
		app.get(API_PATH + '/currentState', function (req, resp) {
			try {
				var level = parseFloat(req.query.level);
				var model = getModel(req.sessionID, req.session);
				
				if (log.info())
					log.info('Fetching current state for level ' + level);
				
				var result = model.currState(level);
				
				if (log.info())
					log.info("Current state: %s", JSON.stringify(result));
				
				resp.send(result);
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		// multilevel analysis
		app.get(API_PATH + '/futureStates', function (req, resp) {
			try {
				var level = parseFloat(req.query.level);
				var currState = parseInt(req.query.state);
				
				var model = getModel(req.sessionID, req.session);
				
				if (req.query.time == null) {
					log.debug('Fetching future states currState: %d, height: %d', currState, level);
					resp.send(model.futureStates(level, currState));
				} else {
					var time = parseFloat(req.query.time);
					log.debug('Fetching future states, currState: %d, level: %d, time: %d', currState, level, time);
					resp.send(model.futureStates(level, currState, time));
				}
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		app.get(API_PATH + '/pastStates', function (req, resp) {
			try {
				var level = parseFloat(req.query.level);
				var currState = parseInt(req.query.state);
				
				var model = getModel(req.sessionID, req.session);
				
				if (req.query.time == null) {
					log.debug('Fetching past states currState: %d, height: %d', currState, level);
					resp.send(model.pastStates(level, currState));
				} else {
					var time = parseFloat(req.query.time);
					log.debug('Fetching past states, currState: %d, level: %d, time: %d', currState, level, time);
					resp.send(model.pastStates(level, currState, time));
				}
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		app.get(API_PATH + '/timeDist', function (req, resp) {
			try {
				var state = parseInt(req.query.state);
				var startTm = parseFloat(req.query.start);
				var endTm = parseFloat(req.query.end);
				var deltaTm = parseFloat(req.query.deltaTm);
				var height = parseFloat(req.query.level);
				
				var model = getModel(req.sessionID, req.session);
				
				resp.send(model.getModel().probsOverTime(height, state, startTm, endTm, deltaTm));
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		app.get(API_PATH + '/history', function (req, resp) {
			try {
				var level = parseFloat(req.query.level);
				var model = getModel(req.sessionID, req.session);
				
				if (log.debug())
					log.debug('Fetching history for level %d', level);
				
				resp.send(model.getModel().histStates(level));
			} catch (e) {
				log.error(e, 'Failed to query MHWirth multilevel visualization!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
	}
	
	{
		log.info('Registering state details service ...');
		
		// state details
		app.get(API_PATH + '/details', function (req, resp) {
			try {
				var stateId = parseInt(req.query.stateId);
				var height = parseFloat(req.query.level);
				
				var model = getModel(req.sessionID, req.session);
				
				if (log.debug())
					log.debug('Fetching details for state: %d', stateId);
				
				resp.send(model.stateDetails(stateId, height));
			} catch (e) {
				log.error(e, 'Failed to query state details!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		// multilevel analysis
		app.get(API_PATH + '/histogram', function (req, resp) {
			try {
				var stateId = parseInt(req.query.stateId);
				var ftrIdx = parseInt(req.query.feature);
				
				var model = getModel(req.sessionID, req.session);
				
				if (log.debug())
					log.debug('Fetching histogram for state %d, feature %d ...', stateId, ftrIdx);
				
				resp.send(model.histogram(stateId, ftrIdx));
			} catch (e) {
				log.error(e, 'Failed to query state details!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		app.get(API_PATH + '/targetFeature', function (req, resp) {
			try {
				var height = parseFloat(req.query.height);
				var ftrIdx = parseInt(req.query.ftr);
				
				var model = getModel(req.sessionID, req.session);
				
				if (log.debug())
					log.debug('Fetching distribution for feature "%d" for height %d ...', ftrIdx, height);
				
				resp.send(model.getFtrDist(height, ftrIdx));
			} catch (e) {
				log.error(e, 'Failed to query state details!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		app.post(API_PATH + '/stateName', function (req, resp) {
			var stateId, stateNm;
			
			try {
				stateId = parseInt(req.body.id);
				stateNm = req.body.name;
				
				var model = getModel(req.sessionID, req.session);
				
				if (log.info()) 
					log.info('Setting name of state %d to %s ...', stateId, stateNm);
				
				model.getModel().setStateName(stateId, stateNm);
				resp.status(204);	// no content
			} catch (e) {
				log.error(e, 'Failed to set name of state %d to %s', stateId, stateNm);
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		app.post(API_PATH + '/setTarget', function (req, resp) {
			var stateId, isTarget, height;
			
			try {
				stateId = parseInt(req.body.id);
				height = parseFloat(req.body.height);
				isTarget = JSON.parse(req.body.isTarget);
				
				var model = getModel(req.sessionID, req.session);
				
				if (log.info()) 
					log.info('Setting target state: %d, isTarget: ' + isTarget, stateId);
				
				
				model.getModel().setTarget(stateId, height, isTarget);
				resp.status(204);	// no content
			} catch (e) {
				log.error(e, 'Failed to set target state %d!', stateId);
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		app.post(API_PATH + '/setControl', function (req, resp) {
			var ftrId, val;
			
			try {
				ftrId = parseInt(req.body.ftrIdx);
				val = parseFloat(req.body.val);
				var stateId = req.body.stateId != null ? parseInt(req.body.stateId) : null;
				
				var model = getModel(req.sessionID, req.session);
				
				if (log.info()) 
					log.info('Changing control %d by factor %d ...', ftrId, val);
				
				model.setControlVal({ ftrId: ftrId, val: val, stateId: stateId});
				resp.send(model.getVizState());
			} catch (e) {
				log.error(e, 'Failed to control %d by factor %d', ftrId, val);
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
		
		app.post(API_PATH + '/resetControl', function (req, resp) {
			try {
				var ftrId = req.body.ftrIdx != null ? parseInt(req.body.ftrIdx) : null;
				var stateId = req.body.stateId != null ? parseInt(req.body.stateId) : null;
				
				var model = getModel(req.sessionID, req.session);
				
				if (log.info()) 
					log.info('Reseting control ...');
				
				model.resetControlVal({ ftrId: ftrId, stateId: stateId});
				resp.send(model.getVizState());
			} catch (e) {
				log.error(e, 'Failed to reset control!');
				resp.status(500);	// internal server error
			}
			
			resp.end();
		});
	}
}

function initDataUpload() {
	var upload = multer({
		storage: multer.memoryStorage(),				// will have file.buffer
		fileFilter: function (req, file, callback) {	// only accept csv files
			var passes = qmutil.stringEndsWith(file.originalname, '.csv');
			log.debug('Filtering uploaded file %s. File passess filter: ' + passes, JSON.stringify(file));
			callback(null, passes);
		}
	});	
	
	function getUserDir(username) {
		return config.QM_USER_BASES_PATH + username;
	}
	
	function getBaseDir(username, timestamp) {
		return getUserDir(username) + '/' + timestamp;
	}
	
	function getDbDir(baseDir) {
		return baseDir + '/db';
	}
	
	function getModelFName(baseDir) {
		return baseDir + '/StreamStory.bin';
	}
	
	function openBase(baseDir) {
		log.info('Opening new base: %s', baseDir);
		
		try {
			var userBase = new qm.Base({
				mode: 'openReadOnly',
				dbPath: getDbDir(baseDir)
			});
			
			var model = new qm.analytics.StreamStory({ 
				base: userBase, 
				fname: getModelFName(baseDir) 
			});
			
			return {base: userBase, model: model};
		} catch (e) {
			log.error(e, 'Failed to open base!');
			throw e;
		}
	}
	
	var fileBuffH = {};
	
	app.post('/upload', upload.single('dataset'), function (req, res, next) {
		var session = req.session;
		
		var fileBuff = req.file.buffer;
		
		fileBuffH[req.sessionID] = fileBuff;
		
		session.fileName = req.file.originalname;
				
		var headers = [];
		qm.fs.readCsvLines(req.file.buffer, {
			lineLimit: 1,
			onLine: function (lineArr) {
				// read the header and create the store
				for (var i = 0; i < lineArr.length; i++) {
					headers.push({ name: lineArr[i] });
				}

				log.debug('Fields read!');
			},
			onEnd: function (err) {
				if (err != null) {
					log.error(err, 'Exception while reading CSV headers!');
					res.status(500);	// internal server error
					res.end();
					return;
				}
				
				log.info('Headers read, sending them back to the UI ...');
				session.headers = headers;
				res.send(headers);
				res.end();
			}
		});
	});
	
	function initBase(req, res) {
		try {
			var session = req.session;
			var sessionId = req.sessionID;
			
			var timeAttr = req.body.time;
			var username = req.body.username;
			var timeUnit = req.body.timeUnit;
			var attrs = req.body.attrs;
			var controlAttrs = req.body.controlAttrs;
			var isRealTime = req.body.isRealTime;
			
			var headers = session.headers;
			
			log.info('Creating a new base for the current user ...');
			var baseDir = getBaseDir(username, new Date().getTime());
			var dbDir = getDbDir(baseDir);
			
			var attrSet = {};
			for (var i = 0; i < attrs.length; i++) {
				attrSet[attrs[i]] = true;
			}
			
			mkdirp(dbDir, function (e) {
				if (e != null) {
					log.error(e, 'Failed to create base directory!');
					log.error(err, 'Exception while parsing the uploaded CSV file!');
					res.status(500);	// internal server error
					return;
				}
				
				var fileBuff = fileBuffH[req.sessionID];	// TODO bit of a hack, take care of possible memory leaks when sessions expire
				delete fileBuffH[req.sessionID];
				
				// create the store and base, depending on wether the model will be 
				// applied in real-time
				var storeNm;
				var userBase;
				var store;
				
				if (isRealTime) {
					log.info('Using real-time base and store ...');
					storeNm = fields.STREAM_STORY_STORE;
					userBase = base;
					store = base.store(storeNm);
				} else {	// not real-time => create a new base and store
					if (log.debug())
						log.debug('Creating new base and store ...');
					
					var storeFields = [];
					for (var i = 0; i < headers.length; i++) {
						var attr = headers[i].name;
						storeFields.push({
							name: attr,
							type: attr == timeAttr ? 'datetime' : 'float',
							'null': false
						});
					}
					
					storeNm = config.QM_USER_DEFAULT_STORE_NAME;
					userBase = new qm.Base({
						mode: 'create',
						dbPath: dbDir
					});
					
					log.debug('Creating default store ...');
					store = userBase.createStore({
						name: storeNm,
						fields: storeFields
					});
				}
				
				// initialize the feature spaces
	    		var obsFields = [];
				var contrFields = [];
				
				var usedFields = {};
				for (var i = 0; i < controlAttrs.length; i++) {
					var fieldNm = controlAttrs[i];
					
					var fieldConfig = {
						field: fieldNm,
						source: storeNm,
						type: 'numeric',
						normalize: true
					}
					
					contrFields.push(fieldConfig);
					usedFields[fieldNm] = true;
				}
				
				for (var i = 0; i < attrs.length; i++) {
					var fieldNm = attrs[i];
					
					if (fieldNm in usedFields || fieldNm == timeAttr) continue;
					
					var fieldConfig = {
						field: fieldNm,
						source: storeNm,
						type: 'numeric',
						normalize: true
					}
					
					obsFields.push(fieldConfig);
				}
				
				var obsFtrSpace = new qm.FeatureSpace(userBase, obsFields);
	    		var controlFtrSpace = new qm.FeatureSpace(userBase, contrFields);
				
	    		var recs = [];
	    		
				// fill the store
				log.debug('Processing CSV file ...');
				var lineN = 0;
				qm.fs.readCsvLines(fileBuff, {
					skipLines: 1,
					onLine: function (lineArr) {
						if (++lineN % 1000 == 0 && log.debug())
							log.debug('Read %d lines ...', lineN);
						
						var recJson = {};
						for (var i = 0; i < headers.length; i++) {
							var attr = headers[i].name;
							if (attr == timeAttr) {
								recJson[attr] = utils.dateToQmDate(new Date(parseInt(lineArr[i])));
							} else {
								recJson[attr] = parseFloat(lineArr[i]);
							}
						}
						
						if (log.trace())
							log.trace('Inserting value: %s', JSON.stringify(recJson));
						
						// create the actual record and update the feature spaces						
						recs.push(store.newRecord(recJson));
					},
					onEnd: function (err) {
						if (err != null) {
							log.error(err, 'Exception while parsing the uploaded CSV file!');
							res.status(500);	// internal server error
							return;
						}
						
						log.info('New store created, building StreamStory model ...');
						
						// create the configuration
						try {
							// create the model
							var model = qm.analytics.StreamStory({
								base: userBase,
								config: {
									transitions: {
										type: 'continuous',
										timeUnit: timeUnit
									},
									clustering: {
										type: 'dpmeans',
										lambda: .7,
										minClusts: 10,
										rndSeed: 1,
										sample: 1,
										histogramBins: 20
									},
									pastStates: 2,
									verbose: true
								},
								obsFtrSpace: obsFtrSpace,
								controlFtrSpace: controlFtrSpace
							});
							
							// fit the model
							// first create a matrix out of the records
							model.fit({
								recV: recs,
								timeField: timeAttr,
								batchEndV: null
							});
							
							if (isRealTime) {
								var fname = config.REAL_TIME_MODELS_PATH + new Date().getTime() + '.bin';
								
								log.info('Saving model ...');
								model.save(fname);
								
								var dbOpts = {
									username: username,
									model_file: fname,
									dataset: session.fileName,
									is_realtime: 1
								}
								
								log.info('Storing a new online model ...');
								db.storeModel(dbOpts, function (e) {
									if (e != null) {
										log.error(e, 'Failed to store offline model to DB!');
										res.status(500);	// internal server error
										res.end();
										return;
									}
									
									try {
										if (log.debug())
											log.debug('Online model stored!');
										
										setNewModel(username, model);
										saveToSession(session, username, userBase, model);
										
										// end request
										res.status(204);	// no content
										res.end();
									} catch (e1) {
										log.error(e1, 'Failed to open base!');
										res.status(500);	// internal server error
										res.end();
									}
								});
							}
							else {
								var modelFile = getModelFName(baseDir);
								
								log.info('Saving model and base ...');
								model.save(modelFile);
								userBase.close();
								log.info('Saved!');
								
								var dbOpts = {
									username: username,
									base_dir: baseDir,
									model_file: modelFile,
									dataset: session.fileName
								}
								
								log.info('Storing a new offline model ...');
								db.storeOfflineModel(dbOpts, function (e) {
									if (e != null) {
										log.error(e, 'Failed to store offline model to DB!');
										res.status(500);	// internal server error
										res.end();
										return;
									}
									
									try {
										if (log.debug())
											log.debug('Offline model stored!');
										
										var baseConfig = openBase(baseDir);
										saveToSession(session, username, baseConfig.base, baseConfig.model);
										
										// end request
										res.status(204);	// no content
										res.end();
									} catch (e1) {
										log.error(e1, 'Failed to open base!');
										res.status(500);	// internal server error
										res.end();
									}
								})
							}
						} catch (e) {
							log.error(e, 'Failed to create the store!');
							res.status(500);	// internal server error
							res.end();
						}
					}
				});
			});
		} catch (e) {
			log.error(e, 'Exception while building model!');
			res.status(500);	// internal server error
			res.end();
		}
	}
	
	app.post(API_PATH + '/configureModel', function (req, res) {
		log.info('Building the model ...');
		
		// create new base with the default store
		log.info('Creating users directory ...');
		var userDirNm = getUserDir(req.body.username);
		
		fs.exists(userDirNm, function (exists) {
			if (exists) {
				log.debug('Reusing directory %s ...', userDirNm);
				initBase(req, res);
			} else {
				fs.mkdir(userDirNm, function (e) {
					if (e != null) {
						log.error(e, 'Failed to create directory!');
						res.status(500);	// internal server error
						res.end();
						return;
					}
					initBase(req, res);
				})
			}
		});
	});
	
	app.get(API_PATH + '/selectDataset', upload.single('dataset'), function (req, res, next) {
		var session = req.session;
		var username = req.query.email;
		
		db.fetchUserModels(username, function (e, models) {
			if (e != null) {
				log.error(e, 'Failed to fetch models for user: %s', username);
				res.status(500);	// internal server error
				res.end();
				return;
			}
			
			session.username = username;
			res.send(models);
			res.end();
		});
	});
	
	app.post(API_PATH + '/selectDataset', function (req, res) {
		var session = req.session;
		var username = session.username;
		
		var modelId = req.body.modelId;
		
		log.info('User %s selected model %s ...', username, modelId);
		
		db.fetchModel(modelId, function (e, modelConfig) {
			if (e != null) {
				log.error(e, 'Failed to get base info for user: %s', username);
				res.status(500);	// internal server error
				res.end();
				return;
			}
			
			try {
				if (modelConfig.is_realtime == 1) {
					var model = new qm.analytics.StreamStory({ 
						base: base, 
						fname: modelConfig.model_file
					});
					setNewModel(modelConfig.model_file, model);
					saveToSession(session, username, base, model);
				} else {
					var baseConfig = openBase(modelConfig.base_dir);
					saveToSession(session, username, baseConfig.base, baseConfig.model);
				}
				
				res.status(204);	// no content
				res.end();
			} catch (e1) {
				log.error(e1, 'Failed to initialize model!');
				res.status(500);	// internal server error
				res.end();
			}
		});
	});
}

function initMhwirthRestApi() {
	app.get(API_PATH + '/config', function (req, resp) {
		try {
			var properties = req.query.properties;
			
			if (log.debug())
				log.debug('Fetching property %s', JSON.stringify(properties));
			
			log.info('Fetching intensities from DB ...');
       		db.getMultipleConfig({properties: properties}, function (e, result) {
       			if (e != null) {
       				log.error(e, 'Failed to fetch properties from DB!');
       				resp.status(500);	// internal server error
       				resp.end();
       				return;
       			}
       			
       			resp.send(result);
       			resp.end();
       		});
		} catch (e) {
			log.error(e, 'Failed to query state details!');
			resp.status(500);	// internal server error
			resp.end();
		}
	});
	
	app.post(API_PATH + '/config', function (req, res) {
		try {
			var config = req.body;
			
			if (log.debug())
				log.debug('Setting configuration %s', JSON.stringify(config));
			
       		db.setConfig(config, function (e, result) {
       			if (e != null) {
       				log.error(e, 'Failed to update settings!');
       				res.status(500);	// internal server error
       				res.end();
       				return;
       			}
       			
       			if ('calc_coeff' in config) {
       				if (log.debug())
       					log.debug('Found calc_coeff in the new configuration. Setting ...')
       				pipeline.setCalcCoeff(config.calc_coeff == 'true');
       			}
       			
       			res.status(204);	// no content
       			res.end();
       		});
		} catch (e) {
			log.error(e, 'Failed to query state details!');
			res.status(500);	// internal server error
			res.end();
		}
	});
}

function initStreamStoryHandlers(model, enable) {
	log.info('Registering StreamStory callbacks ...');
	
	if (model == null) {
		log.warn('StreamStory is NULL, cannot register callbacks ...');
		return;
	}
	
	if (enable) {
		log.info('Registering state changed callback ...');
		model.onStateChanged(function (states) {
			if (log.debug())
				log.debug('State changed: %s', JSON.stringify(states));
					
			modelStore.sendMsg(model.getId(), JSON.stringify({
				type: 'stateChanged',
				content: states
			}));
		});
		
		log.info('Registering anomaly callback ...');
		model.onAnomaly(function (desc) {
			if (log.info())
				log.info('Anomaly detected: %s TODO: currently ignoring!', desc);
			
			// TODO not notifying anyone!
		});
		
		log.info('Registering outlier callback ...');
		model.onOutlier(function (ftrV) {
			if (log.info())
				log.info('Outlier detected!');
			
			modelStore.sendMsg(model.getId(), JSON.stringify({
				type: 'outlier',
				content: ftrV
			}));
		});
		
		log.info('Registering prediction callback ...');
		model.onPrediction(function (date, currState, targetState, prob, probV, timeV) {
			if (log.info())
				log.info('Sending prediction, with PDF length: %d', probV.length);
			
			var msg = {
				type: 'statePrediction',
				content: {
					time: date.getTime(),
					currState: currState,
					targetState: targetState,
					probability: prob,
					pdf: {
						type: 'histogram',
						probV: probV,
						timeV: timeV
					}
				}
			};
			
			var msgStr = JSON.stringify(msg);
			broker.send(broker.PREDICTION_PRODUCER_TOPIC, msgStr);
			modelStore.sendMsg(model.getId(), msgStr);
		});
	} else {
		log.debug('Disabling handlers ...');
		log.debug('Unregistering state changed callback ...');
		model.onStateChanged(null);
		log.debug('Registering anomaly callback ...');
		model.onAnomaly(null);
		log.debug('Registering outlier callback ...');
		model.onOutlier(null);
		log.debug('Registering prediction callback ...');
		model.onPrediction();
	}
}

function initPipelineHandlers() {
	pipeline.onValue(function (val) {
		if (log.trace())
			log.trace('Inserting value into StreamStories ...');
		
		modelStore.updateModels(val);
	});
	
	// configure coefficient callback
	{
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
			log.info('Creating coefficient callback ...');
			pipeline.onCoefficient(function (opts) {
				var pdf = null;
				
				if (math.abs(opts.zScore) >= 5) {
					pdf = {
						type: 'exponential',
						lambda: intensConfig.deviation_extreme_lambda		// degradation occurs once per month
					};
				} else if (math.abs(opts.zScore) >= 4) {					// major deviation
					pdf = {
						type: 'exponential',
						lambda: intensConfig.deviation_major_lambda			// degradation occurs once per two months
					};
				} else if (math.abs(opts.zScore) >= 3) {					// significant deviation
					pdf = {
						type: 'exponential',
						lambda: intensConfig.deviation_significant_lambda	// degradation occurs once per year
					};
				} else if (math.abs(opts.zScore) >= 2) {					// minor deviation
					pdf = {
						type: 'exponential',
						lambda: intensConfig.deviation_minor_lambda			// degradation occurs once per two years
					};
				}
				
				modelStore.distributeMsg(JSON.stringify({
					type: 'coeff',
					content: opts
				}));
				
				if (pdf != null) {
					var msg = msg = {
						type: 'prediction',
						content: {
							time: opts.time,
							eventId: opts.eventId,
							pdf: pdf
						}
					};
					
					var msgStr = JSON.stringify(msg);
					broker.send(broker.PREDICTION_PRODUCER_TOPIC, msgStr);
					modelStore.distributeMsg(msgStr);
				}
			});
		});
	}
}

function initBroker() {
	broker.init();
	
	var imported = 0;
	var printInterval = 100;
	
	broker.onMessage(function (msg) {		
		if (msg.type == 'raw') {
			if (++imported % printInterval == 0 && log.trace())
				log.trace('Imported %d values ...', imported);
			
			addRawMeasurement(msg.payload);
		} else if (msg.type == 'cep') {
			if (log.trace())
				log.trace('received CEP message: %s', JSON.stringify(msg));
			
			addCepAnnotated(msg.payload);
		} else {
			log.warn('Invalid message type: %s', msg.type);
		}
	});
}

function getHackedSessionStore() {
	var store =  new SessionStore();
	store.on('preDestroy', function (sessionId, session) {
		cleanUpSession(session);
	});
	return store;
}

function initServer(sessionStore, parseCookie) {
	log.info('Initializing web server ...');

	app.use(parseCookie);
	app.use(session({ 
		unset: 'destroy',
		store: sessionStore,
		cookie: { maxAge: 60*60*1000 }	// the cookie will last for 1h
//		cookie: { maxAge: 30*1000 }	// the cookie will last for 30 secs
	}));
	// automatically parse body on the API path
	app.use(API_PATH + '/', bodyParser.urlencoded({ extended: false }));
	app.use(API_PATH + '/', bodyParser.json());
	// when a session expires, redirect to index
	app.use('/ui.html', function (req, res, next) {
		var model = getModel(req.sessionID, req.session);
		
		// check if we need to redirect to the index page
		if (model == null) {
			log.info('Session data missing, redirecting to index ...');
			res.redirect('.');
		} else {
			next();
		}
	});
		
	initRestApi();
	initMhwirthRestApi();
	initDataUpload();
	
	// serve static directories on the UI path
	app.use(UI_PATH, express.static(path.join(__dirname, config.WWW_DIR)));
	
	// start server
	var server = app.listen(config.SERVER_PORT);
	
	log.info('================================================');
	log.info('Server running at http://localhost:%d', config.SERVER_PORT);
	log.info('Serving UI at: %s', UI_PATH);
	log.info('Serving API at: %s', API_PATH);
	log.info('Web socket listening at: %s', WS_PATH);
	log.info('================================================');
	
	return server;
}

exports.init = function (opts) {
	log.info('Initializing server ...');
	
	hmc = opts.model;
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
			var model = session.model;
			if (model.getId() != null) {
				modelStore.addWebSocketId(model.getId(), socketId);
			} else {
				log.warn('Model ID not set when opening a new web socket connection!');
			}
		},
		onDisconnected: function (socketId) {
			if (log.debug())
				log.debug('Socket %d disconnected, removing from model store ...', socketId);
			modelStore.removeWebSocketId(socketId);
		}
	});
	
	modelStore = ModelStore({
		ws: ws,
		onAdd: function (model) {
			initStreamStoryHandlers(model, true);
		},
		onRemove: function (model) {
			log.info('Model %s removed from the model store!', model.getId());
		}
	});
	
	initPipelineHandlers();
	initStreamStoryHandlers(hmc, true);
	initBroker();
	
	log.info('Done!');
};
