# Master

# 2.0.6 - 27 May, 2021
### Improvements
- Added support for relative URLs and variables in servers #59

# 2.0.5 - 1 February, 2021
### Improvements
- Added basic support for relative URLs #59
- Update dependencies to fix security vulnerabilities

# 2.0.4 - 26 Nov, 2020
### Improvements
- Nullable is now fully supported
- Update dependencies to fix security vulnerabilities

# 2.0.2 - 7 July, 2020

### Improvements

- Speed-up `api-schema-builder` import by lazy loading required dependencies #54


# 2.0.1 - 13 May, 2020

### Improvements

- Support empty servers in OpenAPI 3.0 spec #50


# 2.0.0 - 23 April, 2020

### New features

- Support for servers and base path in OAS 3 #46

### Improvements

- Speed-up import of `api-schema-builder` and reduce total bundle size by removing polyfills #45

### Breaking changes

- Validate loaded OpenAPI specification (throws an error if it's not a valid OpenAPI 3.0 document) #47
- Drop Node 6 support #45
- If your OpenAPI 3.x specification includes servers definition, some of the endpoints that weren't being matched for validation in the past can start getting validated (if any of servers + path combination matches) #46
