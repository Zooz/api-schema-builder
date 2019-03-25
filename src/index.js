'use strict';

var SwaggerParser = require('swagger-parser'),
    schemaPreprocessor = require('./utils/schema-preprocessor'),
    oas3 = require('./parsers/open-api3'),
    oas2 = require('./parsers/open-api2'),
    ajvUtils = require('./utils/ajv-utils'),
    Ajv = require('ajv'),
    sourceResolver = require('./utils/sourceResolver'),
    Validators = require('./validators/index');

const DEFAULT_SETTINGS = {
    buildRequests: true,
    buildResponses: true
};
function buildSchema(swaggerPath, options) {
    let updatedOptions = Object.assign({}, DEFAULT_SETTINGS, options);
    return Promise.all([
        SwaggerParser.dereference(swaggerPath),
        SwaggerParser.parse(swaggerPath)
    ]).then(function ([dereferenced, referenced]) {
        return buildValidations(referenced, dereferenced, updatedOptions);
    });
}

function buildValidations(referenced, dereferenced, options) {
    const { buildRequests, buildResponses } = options;
    const schemas = {};
    Object.keys(dereferenced.paths).forEach(function (currentPath) {
        let parsedPath = dereferenced.basePath && dereferenced.basePath !== '/'
            ? dereferenced.basePath.concat(currentPath.replace(/{/g, ':').replace(/}/g, ''))
            : currentPath.replace(/{/g, ':').replace(/}/g, '');
        schemas[parsedPath] = {};
        Object.keys(dereferenced.paths[currentPath]).filter(function (parameter) { return parameter !== 'parameters' })
            .forEach(function (currentMethod) {
                let parsedMethod = currentMethod.toLowerCase();

                // build request validator
                let requestValidator;
                if (buildRequests) {
                    requestValidator = buildRequestValidator(referenced, dereferenced, currentPath,
                        parsedPath, currentMethod, options);
                }

                // build response validator
                let responseValidator;
                if (buildResponses) {
                    responseValidator = buildResponseValidator(referenced, dereferenced, currentPath, parsedPath, currentMethod, options);
                }

                schemas[parsedPath][parsedMethod] = Object.assign({}, requestValidator, { responses: responseValidator });
            });
    });
    return schemas;
}

function buildRequestValidator(referenced, dereferenced, currentPath, parsedPath, currentMethod, options){
    let requestSchema = {}, localParameters;
    let pathParameters = dereferenced.paths[currentPath].parameters || [];
    const isOpenApi3 = dereferenced.openapi === '3.0.0';
    const parameters = dereferenced.paths[currentPath][currentMethod].parameters || [];
    if (isOpenApi3) {
        requestSchema.body = oas3.buildRequestBodyValidation(dereferenced, referenced, currentPath, currentMethod, options);
        localParameters = oas3.buildPathParameters(parameters, pathParameters);
    } else {
        let bodySchema = options.expectFormFieldsInBody
            ? parameters.filter(function (parameter) {
                return (parameter.in === 'body' ||
                (parameter.in === 'formData' && parameter.type !== 'file'));
            })
            : parameters.filter(function (parameter) { return parameter.in === 'body' });
        if (options.makeOptionalAttributesNullable) {
            schemaPreprocessor.makeOptionalAttributesNullable(bodySchema);
        }
        if (bodySchema.length > 0) {
            const validatedBodySchema = oas2.getValidatedBodySchema(bodySchema);
            requestSchema.body = oas2.buildRequestBodyValidation(validatedBodySchema, dereferenced.definitions, referenced,
                currentPath, currentMethod, options);
        }
        localParameters = oas2.buildPathParameters(parameters, pathParameters);
    }

    if (localParameters.length > 0 || options.contentTypeValidation) {
        requestSchema.parameters = buildParametersValidation(localParameters,
            dereferenced.paths[currentPath][currentMethod].consumes || dereferenced.paths[currentPath].consumes || dereferenced.consumes, options);
    }

    return requestSchema;
}

function buildResponseValidator(referenced, dereferenced, currentPath, parsedPath, currentMethod, options){
    // support now only oas2
    if (dereferenced.openapi === '3.0.0'){ return }
    let responsesSchema = {};

    let responses = dereferenced.paths[currentPath][currentMethod].responses;

    if (responses) {
        Object.keys(responses).forEach(statusCode => {
            if (statusCode !== 'default') { // create validator only for real status code
                let responseDereferenceSchema = responses[statusCode].schema;
                let responseDereferenceHeaders = responses[statusCode].headers;
                let contentTypes = dereferenced.paths[currentPath][currentMethod].produces || dereferenced.paths[currentPath].produces || dereferenced.produces;
                let headersValidator = (responseDereferenceHeaders || contentTypes) ? buildHeadersValidation(responseDereferenceHeaders, contentTypes, options) : undefined;

                let bodyValidator = oas2.buildResponseBodyValidation(responseDereferenceSchema,
                    dereferenced.definitions, referenced, currentPath, currentMethod, options, statusCode);

                if (headersValidator || bodyValidator) {
                    responsesSchema[statusCode] = new Validators.ResponseValidator({
                        body: bodyValidator,
                        headers: headersValidator
                    });
                }
            }
        });
    }

    return responsesSchema;
}
function createContentTypeHeaders(validate, contentTypes) {
    if (!validate || !contentTypes) return;

    return {
        types: contentTypes
    };
}

function buildParametersValidation(parameters, contentTypes, options) {
    const defaultAjvOptions = {
        allErrors: true,
        coerceTypes: 'array'
        // unknownFormats: 'ignore'
    };
    const ajvOptions = Object.assign({}, defaultAjvOptions, options.ajvConfigParams);
    let ajv = new Ajv(ajvOptions);

    ajvUtils.addCustomKeyword(ajv, options.formats, options.keywords);

    var ajvParametersSchema = {
        title: 'HTTP parameters',
        type: 'object',
        additionalProperties: false,
        properties: {
            headers: {
                title: 'HTTP headers',
                type: 'object',
                properties: {},
                additionalProperties: true
                // plural: 'headers'
            },
            path: {
                title: 'HTTP path',
                type: 'object',
                properties: {},
                additionalProperties: false
            },
            query: {
                title: 'HTTP query',
                type: 'object',
                properties: {},
                additionalProperties: false
            },
            files: {
                title: 'HTTP form files',
                files: {
                    required: [],
                    optional: []
                }
            }
        }
    };

    parameters.forEach(parameter => {
        var data = Object.assign({}, parameter);

        const required = parameter.required;
        const source = sourceResolver.resolveParameterSource(parameter);
        const key = parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name;

        var destination = ajvParametersSchema.properties[source];

        delete data.name;
        delete data.in;
        delete data.required;

        if (data.type === 'file') {
            if (required) {
                destination.files.required.push(key);
            } else {
                destination.files.optional.push(key);
            }
        } else if (source !== 'fields') {
            if (required) {
                destination.required = destination.required || [];
                destination.required.push(key);
            }
            destination.properties[key] = data;
        }
    });

    ajvParametersSchema.properties.headers.content = createContentTypeHeaders(options.contentTypeValidation, contentTypes);

    return new Validators.SimpleValidator(ajv.compile(ajvParametersSchema));
}

function buildHeadersValidation(headers, contentTypes, options) {
    const defaultAjvOptions = {
        allErrors: true,
        coerceTypes: 'array'
    };
    const ajvOptions = Object.assign({}, defaultAjvOptions, options.ajvConfigParams);
    let ajv = new Ajv(ajvOptions);

    ajvUtils.addCustomKeyword(ajv, options.formats, options.keywords);

    var ajvHeadersSchema = {
        title: 'HTTP headers',
        type: 'object',
        properties: {},
        additionalProperties: true
    };

    if (headers) {
        Object.keys(headers).forEach(key => {
            let headerObj = Object.assign({}, headers[key]);
            const headerName = key.toLowerCase();
            delete headerObj.name;
            delete headerObj.required;
            ajvHeadersSchema.properties[headerName] = headerObj;
        });
    }

    ajvHeadersSchema.content = createContentTypeHeaders(options.contentTypeValidation, contentTypes);

    return new Validators.SimpleValidator(ajv.compile(ajvHeadersSchema));
}

module.exports = {
    buildSchema,
    buildValidations
};
