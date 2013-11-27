var realtime = require('realtime');

const STATE_SHOUT = 'shout';
const STATE_CALL = 'private';
const STATE_STANDBY = 'standby';

function RTC(channel){
  this.channel = channel;
  this.options = realtime.options;
  this.localStream = null;
  this.remoteStream = null;
  this.state = STATE_STANDBY;

  this.dataChannels = {};
  this.configuration = {
    'iceServers':[
        {'url':'stun:stun.anyfirewall.com:3478'},
        {'url':'turn:######@turn.anyfirewall.com:3478?transport=udp', 'credential':'######'},
        {'url':'turn:######@turn.anyfirewall.com:443?transport=tcp', 'credential':'######'}
      ]
  };

  this.mediaConstraints = {
    audio: true,
    video: {
      mandatory: {
        maxWidth: 640,
        maxHeight: 480
      }
    }
  };

  this.remoteMediaConstraints = {
    'mandatory': {
      'OfferToReceiveAudio': true,
      'OfferToReceiveVideo': true
    }
  };
  this.pcConstraints = {
    'optional': [{
      'DtlsSrtpKeyAgreement': true
    }]
  };
  this.pc = {};
  this.iceCandidates = {};
  this.dataConfig = {reliable:true};

  _.extend(this, Backbone.Events);
};

/**
 * Returns a peer connection (optionally force a fresh one)
 * @param {User} user model
 * @param boolean fresh whether to create a new one
 */
RTC.prototype.getPeerConnection = function(user, fresh){
  var self = this;
  if (this.pc[user.id]){
    if (fresh){
      this.pc[user.id].onicecandidate = null;
      this.pc[user.id].onnegotiationneeded = null;
      this.pc[user.id].onaddstream = null;
      this.pc[user.id].onremovestream = null;
      this.pc[user.id] = null;
    }
    else {
      return this.pc[user.id];
    }
  }

  this.pc[user.id] = new RTCPeerConnection(this.configuration, this.pcConstraints);
  this.pc[user.id].onicecandidate = function(e){
    if (!e.candidate)
       return;

    self.pc[user.id].localCandidates = self.pc[user.id].localCandidates || 0;
    self.pc[user.id].localCandidates++;
    realtime.send('ice', {
      team: self.channel.id,
      recipientName: user.id,
      candidate: {
        label: e.candidate.sdpMLineIndex,
        id: e.candidate.sdpMid,
        candidate: e.candidate.candidate
      }
    });
  };

  this.pc[user.id].onnegotiationneeded = function(e){
    //TODO reinitialize connection
    console.log("Negotiation needed for "+user.id);
  };

  this.pc[user.id].onaddstream = function(e){
    self.channel.trigger('broadcast', {user:user, stream: e.stream});
    console.log("RTC: adding stream from "+user.id);
  };

  this.pc[user.id].onremovestream = function () {
    self.channel.trigger('stop-broadcast', {user:user});
    console.log("RTC: removing stream from "+user.id);
  };

  this.pc[user.id].oniceconnectionstatechange = function(){
    if (this.iceConnectionState === 'disconnected'){
      setTimeout(function(){
        if (self.pc[user.id].iceConnectionState === 'disconnected'){
          //check again to make sure. Disconnect is triggered async, meanwhile it could be reconnected again.
          self.channel.trigger('stop-broadcast', {user:user});
          self.pc[user.id].close();
          delete self.pc[user.id];
          console.log("RTC: disconnected "+user.id);
        }
      }, 2000);
    }
  }

  //disabled for now
  //this.addDataChannel(user);
  return this.pc[user.id];

};

/**
 * Setup a data Channel for this user
 * @param user
 */
RTC.prototype.addDataChannel = function(user){
  var pc = this.getPeerConnection(user);
  var self = this;
  try {
    console.log('createDataChannel ' + user.id);
    var channel = pc.createDataChannel("Data:"+user.id, this.dataConfig);
    channel.onopen = function() {
      console.log('data stream open ' + user.id);
      self.dataChannels[user.id] = channel;
    };
    channel.onclose = function(event) {
      console.log('data stream close ' + user.id);
    };
    channel.onmessage = function(message) {
      console.log("Got message", message);
    };
    channel.onerror = function(err) {
      console.log('data stream error ' + self.id + ': ' + err);
    };
  }
  catch (error) {
    console.log('seems that DataChannel is NOT actually supported!');
    throw error;
  }
};

/**
 * Shout to channel
 */
RTC.prototype.shout = function(channel){
  var self = this;
  this.state = STATE_SHOUT;
  getUserMedia(self.mediaConstraints, function (s) {
    channel.trigger('broadcast', {user: app.user, stream:s});
    self.localStream = s;
    channel.users.map(function(user){
      if (user.id === app.user.id)
        return;
      self.call(user, s, {stream:false});
    });
  }, function(err){
    console.log(err);
  });
}

/**
 * Private call a user
 * @param user
 */
RTC.prototype.privateCall = function(user){
  var self = this;
  this.state = STATE_CALL;
  getUserMedia(this.mediaConstraints, function (s) {
    self.channel.trigger('broadcast', {user:user, stream: s});
    self.localStream = s;
    //ask for remote stream
    self.call(user, s, {stream:true});
  }, function(err){
    console.log(err);
  });
}

/**
 * Setup a peer connection to user
 * @param user user model
 * @param stream
 */
RTC.prototype.call = function(user, stream){
  var self = this;
  //never setup a peer with ourselves
  if (user.id === app.user.id)
    return;

  var peerConnection = self.getPeerConnection(user, true);
  if (stream)
    peerConnection.addStream(stream);

  peerConnection.createOffer(function (description) {
    localDescription = description;
    peerConnection.setLocalDescription(description);
    realtime.send('offer', {
      team: self.channel.id,
      recipientName: user.id,
      description: description
    });
  }, null, (stream? self.remoteMediaConstraints : null));
};

/**
 * Send an answer
 * @param data
 * @param s optional stream to be attached
 */
RTC.prototype.sendAnswer = function(data, s){
  var self = this;
  var user = app.users.get(data.userName);
  if (s){
    self.pc[user.id].addStream(s);
  }

  self.pc[user.id].createAnswer(function (description) {
    self.pc[user.id].setLocalDescription(description, function(){
      self.pc[user.id].hasDescriptions = true;
      flushCandidates(self, user);
    }, errorHandler);

    console.log("Sending answer to " + user.id);
    realtime.send('answer', {
      team: self.channel.id,
      recipientName: user.id,
      description: description
    });
  }, null, self.remoteMediaConstraints);
};

/**
 * Handle an RTC signaling message
 * Could be an offer, an answer or an ice candidate
 * @param {Object} data the supplied data:
 *   candidate - ice candidate
 *   description - SDP
 *   userName - the sender
 *   recipientName - the recipient
 * @param {Object} options local options e.g. options.stream = true respond with stream
 */
RTC.prototype.handleMessage = function(data, options){
  var self = this;
  if (data.recipientName !== app.user.id)
    return;

  var user = app.users.get(data.userName);
  //an ice candidate
  if (data.candidate){
    var candidate = new RTCIceCandidate({
      sdpMLineIndex: data.candidate.label,
      candidate: data.candidate.candidate
    });
    if (self.pc[user.id] && self.pc[user.id].hasDescriptions){
      self.pc[user.id].remoteCandidates = self.pc[user.id].remoteCandidates || 0;
      self.pc[user.id].remoteCandidates++;
      self.pc[user.id].addIceCandidate(candidate);
    }
    else {
      if (!self.iceCandidates[user.id])
        self.iceCandidates[user.id] = [];
      self.iceCandidates[user.id].push(candidate);
    }
  }
  else if (data.description){
    if (data.description.type === 'offer'){
      self.pc[user.id] = self.getPeerConnection(user, true);
      self.pc[user.id].setRemoteDescription(new RTCSessionDescription(data.description), function(){
        console.log(data.description);
        if (options && options.stream){
          getUserMedia(self.mediaConstraints, function (s) {
            self.channel.trigger('broadcast', {user:user, stream: s});
            self.sendAnswer(data, s);
          }, errorHandler);
        }
        else{
          self.sendAnswer(data);
        }
      }, errorHandler);
    }
    else if (data.description.type === 'answer'){
      self.pc[user.id].setRemoteDescription(new RTCSessionDescription(data.description), function(success){
        console.log(data.description);
        self.pc[user.id].hasDescriptions = true;
        flushCandidates(self, user);
      }, errorHandler);
    }
  }
  else {
    console.log('Invalid message');
  }
}

/**
 * Flush the cached candidates
 * @param rtc RTC instance
 * @param user
 */
function flushCandidates(rtc, user){
  if (!rtc.iceCandidates[user.id])
    return;

  var local = rtc.iceCandidates[user.id];
    rtc.iceCandidates[user.id] = [];
    local.map(function(candidate){
      rtc.pc[user.id].remoteCandidates = rtc.pc[user.id].remoteCandidates || 0;
      rtc.pc[user.id].remoteCandidates++;
    rtc.pc[user.id].addIceCandidate(candidate);
  });
};

function errorHandler(err){
  console.log(err);
};

module.exports = RTC;
