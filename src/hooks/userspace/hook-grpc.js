/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var cls = require('../../cls.js');
var TraceLabels = require('../../trace-labels.js');
var shimmer = require('shimmer');
var semver = require('semver');
var SpanData = require('../../span-data.js');
var findIndex = require('lodash.findindex');

var agent;

var SUPPORTED_VERSIONS = '0.13 - 1';

// # Client

function makeClientMethod(method) {
  return function clientMethodTrace() {
    var root = cls.getRootContext();
    if (!root) {
      agent.logger.debug('Untraced gRPC call: ', method.path);
      return method.apply(this, arguments);
    } else if (root === SpanData.nullSpan) {
      return method.apply(this, arguments);
    }
    // The span name will be of form "grpc:/[Service]/[MethodName]".
    var span = agent.startSpan('grpc:' + method.path);
    // Check if the response is through a stream or a callback.
    if (!method.responseStream) {
      // We need to wrap the callback with the context, to propagate it.
      // The callback is always required. It should be the only function in the
      // arguments, since we cannot send a function as an argument through gRPC.
      var cbIndex = findIndex(arguments, function(arg) {
        return typeof arg === 'function';
      });
      if (cbIndex !== -1) {
        arguments[cbIndex] = wrapCallback(span, arguments[cbIndex]);
      }
    }
    var call = method.apply(this, arguments);
    // Add extra data only when call successfully goes through. At this point
    // we know that the arguments are correct.
    if (agent.config_.enhancedDatabaseReporting) {
      // This finds an instance of Metadata among the arguments.
      // A possible issue that could occur is if the 'options' parameter from
      // the user contains an '_internal_repr' as well as a 'getMap' function,
      // but this is an extremely rare case.
      var metaIndex = findIndex(arguments, function(arg) {
        return arg && typeof arg === 'object' && arg._internal_repr &&
            typeof arg.getMap === 'function';
      });
      if (metaIndex !== -1) {
        var metadata = arguments[metaIndex];
        span.addLabel('metadata', JSON.stringify(metadata.getMap()));
      }
      if (!method.requestStream) {
        span.addLabel('argument', JSON.stringify(arguments[0]));
      }
    }
    // The user might need the current context in listeners to this stream.
    cls.getNamespace().bindEmitter(call);
    if (method.responseStream) {
      var spanEnded = false;
      call.on('error', function(err) {
        if (agent.config_.enhancedDatabaseReporting) {
          span.addLabel('error', err);
        }
        if (!spanEnded) {
          agent.endSpan(span);
          spanEnded = true;
        }
      });
      call.on('status', function(status) {
        if (agent.config_.enhancedDatabaseReporting) {
          span.addLabel('status', JSON.stringify(status));
        }
        if (!spanEnded) {
          agent.endSpan(span);
          spanEnded = true;
        }
      });
    }
    return call;
  };
}

/**
 * Wraps a callback so that the current span for this trace is also ended when
 * the callback is invoked.
 * @param {SpanData} span - The span that should end after this callback.
 * @param {function(?Error, value=)} done - The callback to be wrapped.
 */
function wrapCallback(span, done) {
  var fn = function(err, res) {
    if (agent.config_.enhancedDatabaseReporting) {
      if (err) {
        span.addLabel('error', err);
      }
      if (res) {
        span.addLabel('result', JSON.stringify(res));
      }
    }
    agent.endSpan(span);
    done(err, res);
  };
  return cls.getNamespace().bind(fn);
}

function makeClientConstructorWrap(makeClientConstructor) {
  return function makeClientConstructorTrace(methods) {
    var Client = makeClientConstructor.apply(this, arguments);
    shimmer.massWrap(Client.prototype, Object.keys(methods), makeClientMethod);
    return Client;
  };
}

// # Server

/**
 * A helper function to record metadata in a trace span. The return value of this
 * function can be used as the 'wrapper' argument to wrap sendMetadata.
 * sendMetadata is a member of each of ServerUnaryCall, ServerWriteableStream,
 * ServerReadableStream, and ServerDuplexStream.
 * @param rootContext The span object to which the metadata should be added.
 * @returns {Function} A function that returns a wrapped form of sendMetadata.
 */
function sendMetadataWrapper(rootContext) {
  return function (sendMetadata) {
    return function sendMetadataTrace(responseMetadata) {
      if (rootContext) {
        rootContext.addLabel('metadata', JSON.stringify(responseMetadata.getMap()));
      } else {
        agent.logger.info('gRPC: No root context found in sendMetadata');
      }
      return sendMetadata.apply(this, arguments);
    };
  };
}

/**
 * Wraps a unary function in order to record trace spans.
 * @param {cls.Namespace} namespace The CLS namespace.
 * @param {Object} handlerSet An object containing references to the function handle,
 * as well as serialize and deserialize handles.
 * @param {string} requestName The human-friendly name of the request.
 */
function wrapUnary(namespace, handlerSet, requestName) {
  shimmer.wrap(handlerSet, 'func', function (func) {
    return function serverMethodTrace(call, callback) {
      var that = this;
      var args = arguments;
      // Running in the namespace here propagates context to func.
      return namespace.runAndReturn(function() {
        var rootContext = startRootSpanForRequest(requestName, 5);
        if (agent.config_.enhancedDatabaseReporting) {
          shimmer.wrap(call, 'sendMetadata', sendMetadataWrapper(rootContext));
        }
        if (agent.config_.enhancedDatabaseReporting) {
          rootContext.addLabel('argument', JSON.stringify(call.request));
        }
        // args[1] is the callback.
        // Here, we patch the callback so that the span is ended immediately
        // beforehand.
        args = Array.prototype.slice.call(args);
        args[1] = function (err, result, trailer, flags) {
          if (agent.config_.enhancedDatabaseReporting) {
            if (err) {
              rootContext.addLabel('error', err); 
            } else {
              rootContext.addLabel('result', JSON.stringify(result));
            }
            if (trailer) {
              rootContext.addLabel('trailing_metadata', JSON.stringify(trailer.getMap()));
            }
          }
          endRootSpanForRequest(rootContext);
          return callback(err, result, trailer, flags);
        };
        return func.apply(that, args);
      });
    };
  });
}

/**
 * Wraps a server streaming function in order to record trace spans.
 * @param {cls.Namespace} namespace The CLS namespace.
 * @param {Object} handlerSet An object containing references to the function handle,
 * as well as serialize and deserialize handles.
 * @param {string} requestName The human-friendly name of the request.
 */
function wrapServerStream(namespace, handlerSet, requestName) {
  shimmer.wrap(handlerSet, 'func', function (func) {
    return function serverMethodTrace(stream) {
      var that = this;
      var args = arguments;
      // Running in the namespace here propagates context to func.
      return namespace.runAndReturn(function() {
        var rootContext = startRootSpanForRequest(requestName, 5);
        if (agent.config_.enhancedDatabaseReporting) {
          shimmer.wrap(stream, 'sendMetadata', sendMetadataWrapper(rootContext));
        }
        if (agent.config_.enhancedDatabaseReporting) {
          rootContext.addLabel('argument', JSON.stringify(stream.request));
        }
        var spanEnded = false;
        var endSpan = function () {
          if (!spanEnded) {
            spanEnded = true;
            endRootSpanForRequest(rootContext);
          }
        };
        // Propagate context to stream event handlers.
        namespace.bindEmitter(stream);
        // stream is a WriteableStream. Emitting a 'finish' or 'error' event
        // suggests that no more data will be sent, so we end the span in these
        // event handlers.
        stream.on('finish', function () {
          // End the span unless there is an error. (If there is, the span will
          // be ended in the error event handler. This is to ensure that the
          // 'error' label is applied.)
          if (stream.status.code === 0) {
            endSpan();
          }
        });
        stream.on('error', function (err) {
          if (agent.config_.enhancedDatabaseReporting) {
            rootContext.addLabel('error', err);
          }
          endSpan();
        });
        return func.apply(that, args);
      });
    };
  });
}

/**
 * Wraps a client streaming function in order to record trace spans.
 * @param {cls.Namespace} namespace The CLS namespace.
 * @param {Object} handlerSet An object containing references to the function handle,
 * as well as serialize and deserialize handles.
 * @param {string} requestName The human-friendly name of the request.
 */
function wrapClientStream(namespace, handlerSet, requestName) {
  shimmer.wrap(handlerSet, 'func', function (func) {
    return function serverMethodTrace(stream, callback) {
      var that = this;
      var args = arguments;
      // Running in the namespace here propagates context to func.
      return namespace.runAndReturn(function() {
        var rootContext = startRootSpanForRequest(requestName, 5);
        if (agent.config_.enhancedDatabaseReporting) {
          shimmer.wrap(stream, 'sendMetadata', sendMetadataWrapper(rootContext));
        }
        // Propagate context to stream event handlers.
        // stream is a ReadableStream.
        // Note that unlike server streams, the length of the span is not
        // tied to the lifetime of the stream. It should measure the time for
        // the server to send a response, not the time until all data has been
        // received from the client.
        namespace.bindEmitter(stream);
        // args[1] is the callback.
        // Here, we patch the callback so that the span is ended immediately
        // beforehand.
        args = Array.prototype.slice.call(args);
        args[1] = function (err, result, trailer, flags) {
          if (agent.config_.enhancedDatabaseReporting) {
            if (err) {
              rootContext.addLabel('error', err);
            } else {
              rootContext.addLabel('result', JSON.stringify(result));
            }
            if (trailer) {
              rootContext.addLabel('trailing_metadata', JSON.stringify(trailer.getMap()));
            }
          }
          endRootSpanForRequest(rootContext);
          return callback(err, result, trailer, flags);
        };
        return func.apply(that, args);
      });
    };
  });
}

/**
 * Wraps a bidirectional streaming function in order to record trace spans.
 * @param {cls.Namespace} namespace The CLS namespace.
 * @param {Object} handlerSet An object containing references to the function handle,
 * as well as serialize and deserialize handles.
 * @param {string} requestName The human-friendly name of the request.
 */
function wrapBidi(namespace, handlerSet, requestName) {
  shimmer.wrap(handlerSet, 'func', function (func) {
    return function serverMethodTrace(stream) {
      var that = this;
      var args = arguments;
      // Running in the namespace here propagates context to func.
      return namespace.runAndReturn(function() {
        var rootContext = startRootSpanForRequest(requestName, 5);
        if (agent.config_.enhancedDatabaseReporting) {
          shimmer.wrap(stream, 'sendMetadata', sendMetadataWrapper(rootContext));
        }
        var spanEnded = false;
        var endSpan = function () {
          if (!spanEnded) {
            spanEnded = true;
            endRootSpanForRequest(rootContext);
          }
        };
        // Propagate context in stream event handlers.
        namespace.bindEmitter(stream);
        // stream is a Duplex. Emitting a 'finish' or 'error' event
        // suggests that no more data will be sent, so we end the span in these
        // event handlers.
        // Similar to client streams, the trace span should measure the time
        // until the server has finished sending data back to the client, not
        // the time that all data has been received from the client.
        stream.on('finish', function () {
          // End the span unless there is an error.
          if (stream.status.code === 0) {
            endSpan();
          }
        });
        stream.on('error', function (err) {
          if (!spanEnded && agent.config_.enhancedDatabaseReporting) {
            rootContext.addLabel('error', err);
          }
          endSpan();
        });
        return func.apply(that, args);
      });
    };
  });
}

/**
 * Returns a function that wraps the gRPC server register function in order
 * to create trace spans for gRPC service methods.
 * @param {Function} register The function Server.prototype.register
 * @returns {Function} registerTrace The new wrapper function.
 */
function serverRegisterWrap(register) {
  return function registerTrace(name, handler, serialize, deserialize, method_type) {
    // register(n, h, s, d, m) is called in addService once for each service method.
    // Its role is to assign the serialize, deserialize, and user logic handlers
    // for each exposed service method. Here, we wrap these functions depending on the
    // method type.
    var namespace = cls.getNamespace();
    if (!namespace) {
      agent.logger.info('gRPC: no namespace found, ignoring request');
      return register.apply(this, arguments);
    }
    var result = register.apply(this, arguments);
    var handlerSet = this.handlers[name];
    var requestName = 'grpc:' + name;
    // Proceed to wrap methods that are invoked when a gRPC service call is made.
    // In every case, the function 'func' is the user-implemented handling function.
    if (method_type === 'unary') {
      wrapUnary(namespace, handlerSet, requestName);
    } else if (method_type === 'server_stream') {
      wrapServerStream(namespace, handlerSet, requestName);
    } else if (method_type === 'client_stream') {
      wrapClientStream(namespace, handlerSet, requestName);
    } else if (method_type === 'bidi') {
      wrapBidi(namespace, handlerSet, requestName);
    } else {
      agent.logger.warn('gRPC Server: Unrecognized method_type ' + method_type);
    }
    return result;
  };
}

/**
 * Creates and sets up a new root span for the given request.
 * @param {Object} req The request being processed.
 * @returns {!SpanData} The new initialized trace span data instance.
 */
function startRootSpanForRequest(req, skipFrames) {
  var rootContext = agent.createRootSpanData(req, null, null, skipFrames);
  return rootContext;
}


/**
 * Ends the root span for the given request.
 * @param {!SpanData} rootContext The span to close out.
 */
function endRootSpanForRequest(rootContext) {
  rootContext.addLabel(TraceLabels.HTTP_METHOD_LABEL_KEY, 'POST');
  rootContext.close();
}

// # Exports

module.exports = function(version_, agent_) {
  if (!semver.satisfies(version_, SUPPORTED_VERSIONS)) {
    agent_.logger.info('grpc: unsupported version ' + version_ + ' loaded');
    return {};
  }
  return {
    'src/node/src/client.js': {
      patch: function(client) {
        if (!agent) {
          agent = agent_;
        }
        shimmer.wrap(client, 'makeClientConstructor',
            makeClientConstructorWrap);
      },
      unpatch: function(client) {
        // Only the Client constructor is unwrapped, so that future grpc.load's
        // will not wrap Client methods with tracing. However, existing Client
        // objects with wrapped prototype methods will continue tracing.
        shimmer.unwrap(client, 'makeClientConstructor');
        agent_.logger.info('gRPC makeClientConstructor: unpatched');
      }
    },
    'src/node/src/server.js': {
      patch: function(server) {
        if (!agent) {
          agent = agent_;
        }
        shimmer.wrap(server.Server.prototype, 'register', serverRegisterWrap);
      },
      unpatch: function(server) {
        shimmer.unwrap(server.Server.prototype, 'register');
        agent_.logger.info('gRPC Server: unpatched');
      }
    }
  };
};
