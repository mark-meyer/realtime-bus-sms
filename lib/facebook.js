'use strict';

const request = require('request')
const https   = require('https')
const crypto  = require('crypto')
const config  = require('./config')
const logger  = require('./logger')

/**
 * Process incoming requests from facebook and respond.
 * @module lib/facebook
 */

 /**
  * Hook to handles initial app validation in the Facebook Page setup
  * @param {*} req
  * @param {*} res
  */
function verify(req, res) {
    if (req.query['hub.mode'] === 'subscribe' &&
        req.query['hub.verify_token'] === config.FB_VALIDATION_TOKEN) {
        //logger.info("Validating webhook");
        res.status(200).send(req.query['hub.challenge']);
    } else {
        logger.warn("Failed validation. Make sure the validation tokens match.");
        res.sendStatus(403);
    }
}

/**
 * Hook to handle incoming messages from facebook. Facebook may send
 * batch messages, which breaks the canonical express middleware pattern
 * This uses teh run-middleware module to run each request back through the
 * middleware cycle individually. run-middleware is setup in app.js
 * @param {*} req
 * @param {*} res
 */
function update(req, res) {
    var data = req.body;

    // Make sure this is a page subscription
    if (data.object == 'page') {
        // Iterate over each entry
        // There may be multiple if batched
        let requests = []
        data.entry.forEach(function(pageEntry) {
            var pageID = pageEntry.id;
            var timeOfEvent = pageEntry.time;
            //console.log("messaging: ", pageEntry.messaging)
            // Iterate over each messaging event
            pageEntry.messaging.forEach(function(messagingEvent) {
                if (messagingEvent.message) {
                    requests.push(new Promise((resolve, reject) => {
                        req.runMiddleware('/', {
                            method:'post',
                            body: {Body: messagingEvent.message.text,
                                From: messagingEvent.sender.id,
                                isFB: true}
                        },function(code, data, headers){
                            //data has response from express
                            resolve( module.exports.send(messagingEvent.sender.id, data ))
                        })
                    }))
                } else {
                    logger.warn("fbhook received unknown messagingEvent: ", JSON.stringify(messagingEvent));
                }
            });
        });

        // Waits until all messages have been responded to then sends reply.
        //
        // You must send back a 200, within 20 seconds, to let us know you've
        // successfully received the callback. Otherwise, the request will time out.
        return Promise.all(requests)
        .then(() =>  res.sendStatus(200))
        .catch(() => res.sendStatus(200)) // this returns a 200 to FB even when there are errors

    } else  res.sendStatus(403);
}

/**
 * Respond to facebook message
 * @param {*} recipientId
 * @param {*} messageText
 */
function send(recipientId, messageText) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: messageText,
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };
    //console.log("Trying to send message \"%s\" to recipient %s", messageText, recipientId );
    return new Promise((resolve, reject) => {
        request.post({
            uri: 'https://graph.facebook.com/v2.6/me/messages',
            qs: { access_token: config.FB_PAGE_ACCESS_TOKEN },
            json: messageData

        }, function (error, response, body) {
            if (error || (response.statusCode != 200)) {
                if (error) logger.error("Failed calling Send API: " + error.message);
                if (response)  logger.error("Failed calling Send API: " + response.statusCode + " - " + response.statusMessage);

                reject(new Error("Failed calling Send API"))
            } else {
                resolve("success")
            }
        })
    });
}

/**
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup

 * @param {*} req
 * @param {*} res
 * @param {*} buf
 */
function verifyFBRequestSignature(req, res, buf) {
    var signature = req.headers["x-hub-signature"];
    if (!signature) {
        // For testing, let's log an error. In production, you should throw an
        // error.
        throw new Error("Couldn't validate the signature.");
    } else {
        var elements = signature.split('=');
        var method = elements[0];
        var signatureHash = elements[1];

        var expectedHash = crypto.createHmac('sha1', config.FB_APP_SECRET)
            .update(buf)
            .digest('hex');
       // console.log("Signature: ",signatureHash, " Expected: ", expectedHash);
        if (signatureHash != expectedHash) {
            throw new Error("Couldn't validate the request signature.");
        }
    }
}

module.exports.verify = verify;
module.exports.update = update;
module.exports.send = send
module.exports.verifyFBRequestSignature = verifyFBRequestSignature;
