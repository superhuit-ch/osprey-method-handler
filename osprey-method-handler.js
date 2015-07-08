var is = require('type-is')
var router = require('osprey-router')
var extend = require('xtend')
var parseurl = require('parseurl')
var querystring = require('querystring')
var createError = require('http-errors')
var lowercaseKeys = require('lowercase-keys')
var ramlSanitize = require('raml-sanitize')()
var ramlValidate = require('raml-validate')()
var isStream = require('is-stream')
var values = require('object-values')
var Negotiator = require('negotiator')
var standardHeaders = require('standard-headers')

/**
 * Get all default headers.
 *
 * @type {Object}
 */
var DEFAULT_REQUEST_HEADER_PARAMS = {}

// Fill header params with non-required parameters.
standardHeaders.request.forEach(function (header) {
  DEFAULT_REQUEST_HEADER_PARAMS[header] = { type: 'string' }
})

/**
 * Application body parsers and validators.
 *
 * @type {Array}
 */
var BODY_HANDLERS = [
  ['application/json', jsonBodyHandler],
  ['text/xml', xmlBodyHandler],
  ['application/x-www-form-urlencoded', urlencodedBodyHandler],
  ['multipart/form-data', formDataBodyHandler]
]

/**
 * Set custom file validation.
 *
 * @param  {Stream}  value
 * @return {Boolean}
 */
ramlValidate.TYPES.file = function (stream) {
  return isStream(stream)
}

/**
 * Export `ospreyMethodHandler`.
 */
module.exports = ospreyMethodHandler

/**
 * Create a middleware request/response handler.
 *
 * @param  {Object}   schema
 * @param  {String}   path
 * @return {Function}
 */
function ospreyMethodHandler (schema, path) {
  schema = schema || {}

  var app = router()

  // Attach the resource path to every validation handler.
  app.use(function (req, res, next) {
    req.resourcePath = path

    return next()
  })

  acceptsHandler(app, schema.responses, path)
  bodyHandler(app, schema.body, path)
  headerHandler(app, schema.headers, path)
  queryHandler(app, schema.queryParameters, path)

  return app
}

/**
 * Create a HTTP accepts handler.
 *
 * @param  {Object}   responses
 * @return {Function}
 */
function acceptsHandler (app, responses) {
  var accepts = {}

  // Collect all valid response types.
  Object.keys(responses || {}).forEach(function (code) {
    if (isNaN(code) || code > 300) {
      return
    }

    var response = responses[code]
    var body = response && response.body

    if (!body) {
      return
    }

    Object.keys(body).forEach(function (type) {
      accepts[type] = true
    })
  })

  var mediaTypes = Object.keys(accepts)

  // The user can accept anything when there are no types. We will be more
  // strict when the user tries to respond with a body.
  if (!mediaTypes.length) {
    return
  }

  app.use(function ospreyAccepts (req, res, next) {
    var negotiator = new Negotiator(req)

    if (!negotiator.mediaType(mediaTypes)) {
      return next(createError(
        406, 'Accepted types are ' + mediaTypes.map(JSON.stringify).join(', ')
      ))
    }

    return next()
  })
}

/**
 * Create query string handling middleware.
 *
 * @param  {Object}   queryParameters
 * @return {Function}
 */
function queryHandler (app, queryParameters) {
  // Fast query parameters.
  if (!queryParameters) {
    app.use(function ospreyQueryFast (req, res, next) {
      req.url = parseurl(req).pathname
      req.query = {}

      return next()
    })

    return
  }

  var sanitize = ramlSanitize(queryParameters)
  var validate = ramlValidate(queryParameters)

  app.use(function ospreyQuery (req, res, next) {
    var reqUrl = parseurl(req)
    var query = sanitize(querystring.parse(reqUrl.query))
    var result = validate(query)

    if (!result.valid) {
      return next(createValidationError('query', result.errors))
    }

    var qs = querystring.stringify(query)

    req.url = reqUrl.pathname + (qs ? '?' + qs : '')
    req.query = query

    return next()
  })
}

/**
 * Create a request header handling middleware.
 *
 * @param  {Object}   headerParameters
 * @return {Function}
 */
function headerHandler (app, headerParameters) {
  var headers = extend(DEFAULT_REQUEST_HEADER_PARAMS, lowercaseKeys(headerParameters))

  var sanitize = ramlSanitize(headers)
  var validate = ramlValidate(headers)

  app.use(function ospreyMethodHeader (req, res, next) {
    var headers = sanitize(lowercaseKeys(req.headers))
    var result = validate(headers)

    if (!result.valid) {
      return next(createValidationError('headers', result.errors))
    }

    // Unsets invalid headers.
    req.headers = headers

    return next()
  })
}

/**
 * Handle incoming request bodies.
 *
 * @param  {Object}   bodies
 * @param  {String}   path
 * @return {Function}
 */
function bodyHandler (app, bodies, path) {
  if (!bodies) {
    app.use(discardBody)

    return
  }

  var bodyMap = {}
  var types = Object.keys(bodies)

  BODY_HANDLERS.forEach(function (handler) {
    var type = handler[0]
    var fn = handler[1]
    var result = is.is(type, types)

    if (result) {
      bodyMap[result] = fn(bodies[result], path)
    }
  })

  var validTypes = types.map(JSON.stringify).join(', ')

  app.use(function ospreyContentType (req, res, next) {
    var type = is(req, types)

    if (!type) {
      return next(createError(415, 'Supported content types are ' + validTypes))
    }

    var fn = bodyMap[type]

    return fn ? fn(req, res, next) : next()
  })
}

/**
 * Handle JSON requests.
 *
 * @param  {Object}   body
 * @param  {String}   path
 * @return {Function}
 */
function jsonBodyHandler (body, path) {
  if (!body || !body.schema) {
    console.warn('JSON body schema missing for "' + path + '"')

    return
  }

  var app = router()

  app.use(require('body-parser').json({ type: [] }))
  app.use(jsonBodyValidationHandler(body.schema, path))

  return app
}

/**
 * Validate JSON bodies.
 *
 * @param  {String}   str
 * @param  {String}   path
 * @return {Function}
 */
function jsonBodyValidationHandler (str, path) {
  var tv4 = require('tv4')
  var jsonSchemaCompatibility = require('json-schema-compatibility')
  var schema

  try {
    schema = jsonSchemaCompatibility.v4(JSON.parse(str))
  } catch (e) {
    throw new TypeError(
      'Unable to parse JSON schema for "' + path + '":\n\n' + str
    )
  }

  return function ospreyJsonBody (req, res, next) {
    var result = tv4.validateMultiple(req.body, schema)

    if (!result.valid) {
      return next(createValidationError('json', result.errors))
    }

    return next()
  }
}

/**
 * Handle url encoded form requests.
 *
 * @param  {Object}   body
 * @return {Function}
 */
function urlencodedBodyHandler (body, path) {
  if (!body || !body.formParameters) {
    console.warn('Encoded form parameters missing for "' + path + '"')

    return
  }

  var app = router()

  app.use(require('body-parser').urlencoded({ type: [], extended: false }))
  app.use(urlencodedBodyValidationHandler(body.formParameters))

  return app
}

/**
 * Validate url encoded form bodies.
 *
 * @param  {String} parameters
 * @return {String}
 */
function urlencodedBodyValidationHandler (parameters) {
  var sanitize = ramlSanitize(parameters)
  var validate = ramlValidate(parameters)

  return function ospreyUrlencodedBody (req, res, next) {
    var body = sanitize(req.body)
    var result = validate(body)

    if (!result.valid) {
      return next(createValidationError('form', result.errors))
    }

    // Discards invalid url encoded parameters.
    req.body = body

    return next()
  }
}

/**
 * Handle XML requests.
 *
 * @param  {Object}   body
 * @param  {String}   path
 * @return {Function}
 */
function xmlBodyHandler (body, path) {
  if (!body || !body.schema) {
    console.warn('XML schema missing for "' + path + '"')

    return
  }

  var app = router()

  app.use(require('body-parser').text({ type: [] }))
  app.use(xmlBodyValidationHandler(body.schema, path))

  return app
}

/**
 * Validate XML request bodies.
 *
 * @param  {String}   str
 * @param  {String}   path
 * @return {Function}
 */
function xmlBodyValidationHandler (str, path) {
  var libxml = require('libxmljs')
  var schema

  try {
    schema = libxml.parseXml(str)
  } catch (e) {
    throw new TypeError(
      'Unable to parse XML schema for "' + path + '":\n\n' + str
    )
  }

  return function ospreyXmlBody (req, res, next) {
    var doc

    try {
      doc = libxml.parseXml(req.body)
    } catch (e) {
      return next(createError(400, e.message))
    }

    if (!doc.validate(schema)) {
      return next(createValidationError('xml', doc.validationErrors))
    }

    // Assign parsed XML document to the body.
    req.xml = doc

    return next()
  }
}

/**
 * Handle and validate form data requests.
 *
 * @param  {Object}   body
 * @param  {String}   path
 * @return {Function}
 */
function formDataBodyHandler (body, path) {
  if (!body || !body.formParameters) {
    console.warn('Multipart form parameters missing for "' + path + '"')

    return
  }

  var app = router()
  var Busboy = require('busboy')
  var params = body.formParameters
  var validators = {}
  var sanitizers = {}

  // Asynchonously sanitizes and validates values.
  Object.keys(params).forEach(function (key) {
    var param = extend(params[key])

    // Remove repeated validation and sanitization for async handling.
    delete param.repeat

    sanitizers[key] = ramlSanitize.rule(param)
    validators[key] = ramlValidate.rule(param)
  })

  app.use(function ospreyMethodForm (req, res, next) {
    var received = {}
    var errored = false
    var busboy = req.form = new Busboy({ headers: req.headers })
    var errors = {}

    // Override `emit` to provide validations.
    busboy.emit = function emit (type, name, value, a, b, c) {
      var close = type === 'field' ? noop : function () {
        value.resume()
      }

      if (type === 'field' || type === 'file') {
        if (!params.hasOwnProperty(name)) {
          return close()
        }

        // Sanitize the value before emitting.
        value = sanitizers[name](value)

        // Check for repeat errors.
        if (received[name] && !params[name].repeat) {
          errors[name] = {
            valid: false,
            rule: 'repeat',
            value: value,
            key: name
          }

          errored = true

          return close()
        }

        // Set the value to be already received.
        received[name] = true

        // Check the value is valid.
        var result = validators[name](value)

        // Collect invalid values.
        if (!result.valid) {
          errored = true
          errors[name] = result
        }

        // Don't emit when an error has already occured. Check after the
        // value validation because we want to collect all possible errors.
        if (errored) {
          return close()
        }
      } else if (type === 'finish') {
        // Finish emits twice, but is actually done the second time.
        if (!this._done) {
          return Busboy.prototype.emit.call(this, 'finish')
        }

        var validationErrors = Object.keys(params)
          .filter(function (key) {
            return params[key].required && !received[key]
          })
          .map(function (key) {
            return {
              valid: false,
              rule: 'required',
              value: undefined,
              key: key
            }
          })
          .concat(values(errors))

        if (validationErrors.length) {
          Busboy.prototype.emit.call(
            this,
            'error',
            createValidationError('form', validationErrors)
          )

          return
        }
      }

      return Busboy.prototype.emit.apply(this, arguments)
    }

    return next()
  })

  return app
}

/**
 * Create a validation error.
 *
 * @param  {String} type
 * @param  {Array}  errors
 * @return {Error}
 */
function createValidationError (type, errors) {
  var self = createError(400, 'Invalid ' + type)

  self.ramlValidation = self.validationType = type
  self.validationErrors = errors

  return self
}

/**
 * Discard the request body.
 *
 * @param {Object}   req
 * @param {Object}   res
 * @param {Function} next
 */
function discardBody (req, res, next) {
  req.resume()
  req.on('end', next)
  req.on('error', next)
}

/**
 * Noop.
 */
function noop () {}
