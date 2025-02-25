import * as convert from 'xml-js';
import * as _ from 'underscore';
import {ParseConformance, ParsedProperty, ParsedStructure} from './parseConformance';
import {XmlHelper} from './xmlHelper';

interface XmlDeclaration {
    attributes?: { [id: string]: any };
}

interface XmlElement {
    name?: string;
    attributes?: { [id: string]: any };
    elements?: XmlElement[];
    declaration?: XmlDeclaration;
    type?: string;
}

export class ConvertToXml {
    /**
     * A list of properties that should be treated as attributes when serializing to XML.
     * Key = parent type
     * Value = property name
     * @type {obj}
     */
    readonly attributeProperties = {
        'Extension': 'url'
    };
    
    private parser: ParseConformance;
    
    constructor(parser?: ParseConformance) {
        this.parser = parser || new ParseConformance(true);
    }

    /**
     * Converts the specified object to XML
     * @param {FHIR.Resource} obj
     * @returns {string}
     */
    public convert(obj: any) {
        if (obj.hasOwnProperty('resourceType')) {
            const xmlObj = this.resourceToXML(obj);
            return convert.js2xml(xmlObj);
        }
    }

    /**
     * @param obj
     * @param xmlObj
     * @returns {*}
     * @private
     */
    private resourceToXML(obj: any, xmlObj?: XmlElement) {
        const resourceElement: XmlElement = {
            type: 'element',
            name: obj.resourceType,
            attributes: {
                xmlns: 'http://hl7.org/fhir'
            },
            elements: []
        };

        if (!xmlObj) {
            xmlObj = {
                declaration: {
                    attributes: {
                        version: '1.0',
                        encoding: 'UTF-8'
                    }
                },
                elements: [resourceElement]
            };
        }

        if (!this.parser.parsedStructureDefinitions[obj.resourceType]) {
            throw new Error('Unknown resource type: ' + obj.resourceType);
        }

        _.each(this.parser.parsedStructureDefinitions[obj.resourceType]._properties, (property) => {
            this.propertyToXML(resourceElement, this.parser.parsedStructureDefinitions[obj.resourceType], obj, property._name);
        });

        return xmlObj;
    }

    /**
     * @param parentXmlObj
     * @param parentType
     * @param obj
     * @param propertyName
     * @private
     */
    private propertyToXML(parentXmlObj: XmlElement, parentType: ParsedStructure, obj: any, propertyName: string, parentPropertyType?: string) {
        // id without a parentPropertyType means it is an id of a resource, which would produce an <id> element
        const isAttribute = (propertyName === 'id' && !!parentPropertyType) || this.attributeProperties[parentPropertyType] === propertyName;

        if (!obj || obj[propertyName] === undefined || obj[propertyName] === null) return;

        const propertyType = _.find(parentType._properties, (property: ParsedProperty) => property._name == propertyName);

        function xmlEscapeString(value) {
            return value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\r/g, '&#xD;')
                .replace(/\n/g, '&#xA;');
        }

        const pushProperty = (value, extra?) => {
            if (value === undefined || value === null) return;

            const nextXmlObj: XmlElement = {
                type: 'element',
                name: propertyName,
                elements: [],
                attributes: {}
            };

            if (extra) {
                if (extra.id) {
                    nextXmlObj.attributes.id = extra.id;
                }

                if (extra.extension) {
                    const extensionStructure = this.parser.parsedStructureDefinitions['Extension'];
                    this.propertyToXML(nextXmlObj, extensionStructure, extra, 'extension');
                }
            }

            switch (propertyType._type) {
                case 'string':
                case 'base64Binary':
                case 'code':
                case 'id':
                case 'markdown':
                case 'uri':
                case 'url':
                case 'canonical':
                case 'oid':
                case 'boolean':
                case 'integer':
                case 'decimal':
                case 'unsignedInt':
                case 'positiveInt':
                case 'date':
                case 'dateTime':
                case 'time':
                case 'instant':
                    const actual = !value || !(typeof value === 'string') ? value : xmlEscapeString(value);

                    nextXmlObj.attributes.value = actual;
                    break;
                case 'xhtml':
                    if (propertyName === 'div') {
                        let divXmlObj;

                        try {
                            divXmlObj = convert.xml2js(value);
                            divXmlObj = XmlHelper.escapeInvalidCharacters(divXmlObj);
                        } catch (ex) {
                            throw new Error('The embedded xhtml is not properly formatted/escaped: ' + ex.message);
                        }

                        nextXmlObj.attributes.xmlns = 'http://www.w3.org/1999/xhtml';

                        if (divXmlObj.elements.length === 1 && divXmlObj.elements[0].name === 'div') {
                            nextXmlObj.elements = divXmlObj.elements[0].elements;
                        }
                    }
                    break;
                case 'Resource':
                    const resourceXmlObj = this.resourceToXML(value).elements[0];
                    delete resourceXmlObj.attributes.xmlns;
                    nextXmlObj.elements.push(resourceXmlObj);
                    break;
                case 'Element':
                case 'BackboneElement':
                    for (let x in propertyType._properties) {
                        const nextProperty = propertyType._properties[x];
                        this.propertyToXML(nextXmlObj, propertyType, value, nextProperty._name, propertyType._type);
                    }
                    break;
                default:
                    let nextType = this.parser.parsedStructureDefinitions[propertyType._type];

                    if (propertyType._type.startsWith('#')) {
                        const typeSplit = propertyType._type.substring(1).split('.');
                        for (let i = 0; i < typeSplit.length; i++) {
                            if (i == 0) {
                                nextType = this.parser.parsedStructureDefinitions[typeSplit[i]];
                            } else {
                                nextType = _.find(nextType._properties, (nextTypeProperty) => {
                                    return nextTypeProperty._name === typeSplit[i];
                                });
                            }

                            if (!nextType) {
                                break;
                            }
                        }
                    }

                    if (!nextType) {
                        console.log('Could not find type ' + propertyType._type);
                    } else {
                        _.each(nextType._properties, (nextProperty) => {
                            this.propertyToXML(nextXmlObj, nextType, value, nextProperty._name, propertyType._type);
                        });
                    }
            }

            if (isAttribute && nextXmlObj.attributes && nextXmlObj.attributes.hasOwnProperty('value')) {
                if (!parentXmlObj.attributes) {
                    parentXmlObj.attributes = {};
                }
                parentXmlObj.attributes[nextXmlObj.name] = nextXmlObj.attributes['value'];
            } else {
                parentXmlObj.elements.push(nextXmlObj);
            }
        }

        if (obj[propertyName] && propertyType._multiple) {
            for (let i = 0; i < obj[propertyName].length; i++) {
                const extra = obj['_' + propertyName] && obj['_' + propertyName] instanceof Array ? obj['_' + propertyName][i] : undefined;
                pushProperty(obj[propertyName][i], extra);
            }
        } else {
            pushProperty(obj[propertyName], obj['_' + propertyName]);
        }
    }
}