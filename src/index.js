'use strict';
const get = require('lodash.get');
const Ajv = require('ajv');
const { URL } = require('url');

const { defaultFormatsValidators } = require('./validators/formatValidators.js');
const schemaPreprocessor = require('./utils/schema-preprocessor');
const oai3 = require('./parsers/open-api3');
const oai2 = require('./parsers/open-api2');
const ajvUtils = require('./utils/ajv-utils');
const schemaUtils = require('./utils/schemaUtils');
const sourceResolver = require('./utils/sourceResolver');
const Validators = require('./validators/index');
const createContentTypeHeaders = require('./utils/createContentTypeHeaders');
const { loadSchemaAsync, loadSchema } = require('./utils/schemaLoaders.js');

const DEFAULT_OPTIONS = {
    buildRequests: true,
    buildResponses: true
};

async function buildSchema(swaggerPath, options) {
    const { jsonSchema, dereferencedSchema } = await loadSchemaAsync(swaggerPath, options);

    return buildValidations(jsonSchema, dereferencedSchema, options);
}

function buildSchemaSync(pathOrSchema, options) {
    const { jsonSchema, dereferencedSchema } = loadSchema(pathOrSchema, options);

    return buildValidations(jsonSchema, dereferencedSchema, options);
}

function getBasePaths(dereferenced) {
    return dereferenced.servers && dereferenced.servers.length
        ? dereferenced.servers.map(({ url, variables = {} }) => {
        // replace variables with deafault values
            Object.keys(variables).forEach((key) => {
                url = url.replace(new RegExp(`{${key}}`), variables[key].default);
            });

            // replace leading '//' with 'http://' (in cases such as //api.example.com)
            url = url.replace(/^\/\//, 'http://');

            // return base path
            return (/\/\//.test(url)) ? new URL(url).pathname : url;
        })
        : [dereferenced.basePath || '/'];
}

function buildValidations(referenced, dereferenced, receivedOptions) {
    const options = getOptions(receivedOptions);

    const schemas = {};

    const basePaths = getBasePaths(dereferenced);

    Object.keys(dereferenced.paths).forEach(currentPath => {
        const operationSchemas = {};
        Object.keys(dereferenced.paths[currentPath])
            .filter(parameter => parameter !== 'parameters')
            .forEach(currentMethod => {
                const parsedMethod = currentMethod.toLowerCase();

                let requestValidator;
                if (options.buildRequests) {
                    requestValidator = buildRequestValidator(
                        referenced,
                        dereferenced,
                        currentPath,
                        currentMethod,
                        options
                    );
                }

                let responseValidator;
                if (options.buildResponses) {
                    responseValidator = buildResponseValidator(
                        referenced,
                        dereferenced,
                        currentPath,
                        currentMethod,
                        options
                    );
                }

                operationSchemas[parsedMethod] = Object.assign({}, requestValidator, { responses: responseValidator });
            });

        basePaths.forEach(basePath => {
            const normalizedPath = basePath.replace(/\/$/, '') + currentPath.replace(/{(\w+)}/g, ':$1');
            schemas[normalizedPath] = operationSchemas;
        });
    });

    return schemas;
}

function getOptions(opts = {}) {
    const formats = opts.formats
        ? defaultFormatsValidators.concat(opts.formats)
        : defaultFormatsValidators;

    return Object.assign(
        {},
        DEFAULT_OPTIONS,
        opts,
        { formats }
    );
}

function buildRequestValidator(referenced, dereferenced, currentPath, currentMethod, options) {
    const requestSchema = {};
    let localParameters = [];
    const pathParameters = dereferenced.paths[currentPath].parameters || [];
    const isOpenApi3 = schemaUtils.getOAIVersion(dereferenced) === 3;
    const parameters = dereferenced.paths[currentPath][currentMethod].parameters || [];
    if (isOpenApi3) {
        requestSchema.body = oai3.buildRequestBodyValidation(dereferenced, referenced, currentPath, currentMethod, options);
        localParameters = oai3.buildPathParameters(parameters, pathParameters);
    } else {
        const bodySchema = options.expectFormFieldsInBody
            ? parameters.filter(function (parameter) {
                return (parameter.in === 'body' ||
                    (parameter.in === 'formData' && parameter.type !== 'file'));
            })
            : parameters.filter(function (parameter) { return parameter.in === 'body' });

        options.makeOptionalAttributesNullable && schemaPreprocessor.makeOptionalAttributesNullable(bodySchema);

        if (bodySchema.length > 0) {
            const validatedBodySchema = oai2.getValidatedBodySchema(bodySchema);
            requestSchema.body = oai2.buildRequestBodyValidation(validatedBodySchema, dereferenced.definitions, referenced,
                currentPath, currentMethod, options);
        }

        localParameters = oai2.buildPathParameters(parameters, pathParameters);
    }

    requestSchema.parameters = buildParametersValidation(localParameters,
        dereferenced.paths[currentPath][currentMethod].consumes || dereferenced.paths[currentPath].consumes || dereferenced.consumes, options);

    return requestSchema;
}

function buildResponseValidator(referenced, dereferenced, currentPath, currentMethod, options) {
    const responsesSchema = {};
    const isOpenApi3 = schemaUtils.getOAIVersion(dereferenced) === 3;
    const responses = get(dereferenced, `paths[${currentPath}][${currentMethod}].responses`);
    if (responses) {
        Object
            .keys(responses)
            .forEach(statusCode => {
                let headersValidator, bodyValidator;
                if (isOpenApi3) {
                    headersValidator = oai3.buildHeadersValidation(responses, statusCode, options);
                    bodyValidator = oai3.buildResponseBodyValidation(dereferenced, referenced,
                        currentPath, currentMethod, statusCode, options);
                } else {
                    const contentTypes = dereferenced.paths[currentPath][currentMethod].produces || dereferenced.paths[currentPath].produces || dereferenced.produces;
                    headersValidator = oai2.buildHeadersValidation(responses, contentTypes, statusCode, options);
                    bodyValidator = oai2.buildResponseBodyValidation(responses,
                        dereferenced.definitions, referenced, currentPath, currentMethod, statusCode, options);
                }

                if (headersValidator || bodyValidator) {
                    responsesSchema[statusCode] = new Validators.ResponseValidator({
                        body: bodyValidator,
                        headers: headersValidator
                    });
                }
            });
    }

    return responsesSchema;
}

function buildParametersValidation(parameters, contentTypes, options) {
    const defaultAjvOptions = {
        allErrors: true,
        coerceTypes: 'array'
        // unknownFormats: 'ignore'
    };
    const ajvOptions = Object.assign({}, defaultAjvOptions, options.ajvConfigParams);
    const ajv = new Ajv(ajvOptions);

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

module.exports = {
    buildSchemaSync,
    buildSchema,
    buildValidations
};
