var express = require('express')
  , routes = require('./routes')
  , http = require('http')
  , path = require('path');

var app = express();
var server = http.createServer(app)

app.configure(function(){
  app.set('port', process.env.PORT || 3000);
  app.set('views', __dirname + '/views');
  app.set('view engine', 'ejs');
  app.use(express.favicon());
  app.use(express.logger('dev'));
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(app.router);
  app.use(express.static(path.join(__dirname, 'public')));
});

app.get('/', routes.index);

server.listen(app.get('port'), function(){
  console.log("Express server listening on port " + app.get('port'));
});

// ------------ MOSCA -------------

var mosca = require('mosca');
var ascoltatore = {
  type: 'mongo',
  url: 'mongodb://localhost/devices',
  pubsubCollection: 'mqtt',
  mongo: {}
};

var settings = {
  port: 1883,
  //stats:true,
  backend: ascoltatore,
  persistence: {
    factory: mosca.persistence.Mongo,
    url: 'mongodb://localhost/mqtt'
  }

};

var mqtt = new mosca.Server(settings);
//var mqttStats = new mosca.Stats()


var authenticate = function(client, username, password, callback) {
	if(username||password){
		var mqtt_user = username.toString('utf8');
		var mqtt_pass = password.toString('utf8');
		Device.findOne({key: mqtt_user, secret: mqtt_pass}, function (err, doc){
			if(doc){
				console.log('User',mqtt_user,'connected via MQTT.');
				client.key = mqtt_user;
				callback(null, true);		
				doc.online = true;
				doc.save();
				io.sockets.in('device_'+mqtt_user).emit('device online', {key:mqtt_user,secret:mqtt_pass,online:true});
				setTimeout(function(){mqtt.publish({topic: 'devices/'+mqtt_user,payload: doc.value,qos: 0,retain: false})},1000);
			}else if(username=="admin" && password=="admin"){
				client.isAdmin = true;
				callback(null, true);
			}else{
				callback(null, false);
				console.log('"'+mqtt_user+'" tried to login - password "'+mqtt_pass+'" wrong.');			
				}
		});
	}else{
		callback(null, false);
		console.log('User tried to login without credentials.');			
	}
}
var authorizePublish = function(client, topic, payload, callback) {
	if(client.isAdmin){
		callback(null,true);
	}else{
  callback(null, 'devices/'+client.key == topic.split('/')[0]+'/'+topic.split('/')[1]);
	}
}
var authorizeSubscribe = function(client, topic, callback) {
	if(client.isAdmin){
		callback(null,true);
	}else{
  callback(null, 'devices/'+client.key == topic.split('/')[0]+'/'+topic.split('/')[1]);
	}
}

mqtt.on('ready', moscasetup);

function moscasetup() {
  mqtt.authenticate = authenticate;
  mqtt.authorizePublish = authorizePublish;
  mqtt.authorizeSubscribe = authorizeSubscribe;
  console.log('Mosca server is running and connected to MongoDB!');
}

mqtt.on('clientDisconnected', function(client) {
	if(client.key){
	console.log('Client "'+client.key+'" disconnected via MQTT.');
  			Device.findOne({ key:client.key }, function (err, doc){
					  doc.online = false;
					  doc.save();
					});	
			io.sockets.in('device_'+client.key).emit('device online', {key: client.key, online: false});
			
	}
});
mqtt.on('published', function(packet, client) {
	if(packet.topic.toString().split('/')[0]=="devices" && packet.topic.toString().split('/')[2]=="action"){
		io.sockets.in('device_'+packet.topic.toString().split('/')[1]).emit('action', {key:packet.topic.toString().split('/')[1],value:packet.payload.toString()});
	}
	if(packet.topic.trim().substr(0,1)!='$'){
  console.log('Published', packet.topic.toString(),': ',packet.payload.toString());
}
});
// ------------ END MOSCA -------------

var io = require("socket.io").listen(server);
var mongoose = require('mongoose');
var users = {};

mongoose.connect('mongodb://localhost/devices', function(err){
	if(err){
		console.log(err);
	}else{
		console.log('Socket.io is running and connected to MongoDB!');
	}
});

var devicesSchema = mongoose.Schema({
	key: String,
	secret: String,
	name: String,
	value: String,
	online: Boolean,
	dimming: Boolean
});


var Device = mongoose.model('Device', devicesSchema);


io.sockets.on('connection', function (socket) {

	socket.emit('news','welcome ' + socket.id);
	users[socket.id] = socket;
	io.sockets.emit('userlist', Object.keys(users));	
	io.sockets.emit('roomlist', Object.keys(io.sockets.manager.rooms));	

	//io.sockets.emit('news', socket.id + ' connected.');


	socket.on('mesage_name', function (data) {
		socket.emit('mesage_name',data);

});
	socket.on('device login', function (data) {
		socket.emit('news','Device ' + data.key + ' registered.');
		socket.join('device_'+data.key);
			Device.find({key: data.key}, function (err, doc){
				if(doc.length){
					socket.emit('devices',{key: data.key, secret: data.secret, value: doc[0].value, name: doc[0].name, online: doc[0].online, dimming: doc[0].dimming});
				}else{
					socket.emit('devices',{key: data.key, secret: data.secret, value: '', name: 'New Device', online: false, dimming: true});
				}
			});
		socket.emit('news', 'Subscribed device_'+data.key);
		io.sockets.emit('roomlist', Object.keys(io.sockets.manager.rooms));	

	});

	socket.on('devices', function (data) {
			//DB
			Device.find({key:data.key},function(err, devices){
			if(devices.length){
				//Device gefunden, updaten
					Device.findOne({ key:data.key }, function (err, doc){
					  doc.value = data.value;
					  doc.save();
					});			
				}else{
				var device = new Device({key: data.key, value: data.value, name: 'New Device'});
				device.save();
				}
			});
				//Steuerbefehl
			socket.broadcast.in('device_'+data.key).emit('action', data);
			mqtt.publish({topic: 'devices/'+data.key,payload: data.value,qos: 0,retain: false});

	});

	socket.on('device name', function (data) {
			//DB
			Device.find({key:data.key},function(err, devices){
			if(devices.length){
				//Device gefunden, updaten
					Device.findOne({ key:data.key }, function (err, doc){
					  doc.name = data.name;
					  doc.save();
					});			
				}else{
				var device = new Device({key: data.key, name: data.name});
				device.save();
				}
			});
				//Steuerbefehl
			socket.broadcast.in('device_'+data.key).emit('device name', data);
	});

	socket.on('device online', function (data) {
			//DB
			Device.find({key:data.key},function(err, devices){
			if(devices.length){
				//Device gefunden, updaten
					Device.findOne({ key:data.key }, function (err, doc){
					  doc.online = true;
					  doc.save();
					});			
				}else{
				var device = new Device({key: data.key, name: data.name, online: true});
				device.save();
				}
			});
			socket.key = data.key;
			socket.isDevice = true;
				//Updatebefehl
			socket.broadcast.in('device_'+data.key).emit('device online', data);
	});

	socket.on('device dimming', function (data) {
			//DB
			Device.find({key:data.key},function(err, devices){
			if(devices.length){
				//Device gefunden, updaten
					Device.findOne({ key:data.key }, function (err, doc){
					  doc.dimming = data.dimming;
					  doc.save();
					});			
				}else{
				var device = new Device({key: data.key, name: data.name, dimming: data.dimming});
				device.save();
				}
			});
				//Updatebefehl
			socket.broadcast.in('device_'+data.key).emit('device dimming', data);
	});

	socket.on('disconnect', function () {
  		//io.sockets.emit('news', socket.id + ' disconnected.');
  		delete(users[socket.id]);
  		if(socket.isDevice){
  			Device.findOne({ key:socket.key }, function (err, doc){
					  doc.online = false;
					  doc.save();
					});	
			socket.broadcast.in('device_'+socket.key).emit('device online', {key: socket.key, online: false});
  		}
  		io.sockets.emit('userlist', Object.keys(users));
  		io.sockets.emit('roomlist', Object.keys(io.sockets.manager.rooms));	

	});

});