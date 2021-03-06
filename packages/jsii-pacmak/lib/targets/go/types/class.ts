import { CodeMaker, toPascalCase } from 'codemaker';
import { Method, ClassType, Initializer } from 'jsii-reflect';

import * as comparators from '../comparators';
import { EmitContext } from '../emit-context';
import { Package } from '../package';
import {
  ClassConstructor,
  JSII_RT_ALIAS,
  MethodCall,
  StaticGetProperty,
  StaticSetProperty,
} from '../runtime';
import { getMemberDependencies, getParamDependencies } from '../util';
import { GoType } from './go-type';
import { GoTypeRef } from './go-type-reference';
import { GoInterface } from './interface';
import { GoParameter, GoMethod, GoProperty } from './type-member';

/*
 * GoClass wraps a Typescript class as a Go custom struct type
 */
export class GoClass extends GoType {
  public readonly methods: ClassMethod[];
  public readonly staticMethods: StaticMethod[];
  public readonly properties: GoProperty[];
  public readonly staticProperties: GoProperty[];

  private readonly reimplementedMethods?: readonly ClassMethod[];
  private readonly reimplementedProperties?: readonly GoProperty[];

  private _extends?: GoClass | null;
  private _implements?: readonly GoInterface[];

  private readonly initializer?: GoClassConstructor;

  public constructor(pkg: Package, public type: ClassType) {
    super(pkg, type);

    const methods = new Array<ClassMethod>();
    const staticMethods = new Array<StaticMethod>();
    for (const method of type.ownMethods) {
      if (method.static) {
        staticMethods.push(new StaticMethod(this, method));
      } else {
        methods.push(new ClassMethod(this, method));
      }
    }
    // Ensure consistent order, mostly cosmetic.
    this.methods = methods.sort(comparators.byName);
    this.staticMethods = staticMethods.sort(comparators.byName);

    const properties = new Array<GoProperty>();
    const staticProperties = new Array<GoProperty>();
    for (const prop of type.ownProperties) {
      if (prop.static) {
        staticProperties.push(new GoProperty(this, prop));
      } else {
        properties.push(new GoProperty(this, prop));
      }
    }
    // Ensure consistent order, mostly cosmetic.
    this.properties = properties.sort(comparators.byName);
    this.staticProperties = staticProperties.sort(comparators.byName);

    // If there is more than one base, and any ancestor (including transitive)
    // comes from a different assembly, we will re-implement all members on the
    // proxy struct, as otherwise we run the risk of un-promotable methods
    // caused by inheriting the same interface via multiple paths (since we have
    // to represent those as embedded types).
    const hasMultipleBases = type.interfaces.length > (type.base ? 0 : 1);
    if (
      hasMultipleBases &&
      type
        .getAncestors()
        .some((ancestor) => ancestor.assembly.fqn !== type.assembly.fqn)
    ) {
      this.reimplementedMethods = type.allMethods
        .filter((method) => !method.static && method.definingType !== type)
        .map((method) => new ClassMethod(this, method))
        .sort(comparators.byName);

      this.reimplementedProperties = type.allProperties
        .filter(
          (property) => !property.static && property.definingType !== type,
        )
        .map((property) => new GoProperty(this, property))
        .sort(comparators.byName);
    }

    if (type.initializer) {
      this.initializer = new GoClassConstructor(this, type.initializer);
    }
  }

  public get extends(): GoClass | undefined {
    // Cannot compute in constructor, as dependencies may not have finished
    // resolving just yet.
    if (this._extends === undefined) {
      this._extends = this.type.base
        ? (this.pkg.root.findType(this.type.base.fqn) as GoClass)
        : null;
    }
    return this._extends == null ? undefined : this._extends;
  }

  public get implements(): readonly GoInterface[] {
    // Cannot compute in constructor, as dependencies may not have finished
    // resolving just yet.
    if (this._implements === undefined) {
      this._implements = this.type.interfaces
        .map((iface) => this.pkg.root.findType(iface.fqn) as GoInterface)
        // Ensure consistent order, mostly cosmetic.
        .sort((l, r) => l.fqn.localeCompare(r.fqn));
    }
    return this._implements;
  }

  public get baseTypes(): ReadonlyArray<GoClass | GoInterface> {
    return [...(this.extends ? [this.extends] : []), ...this.implements];
  }

  public emit(context: EmitContext): void {
    this.emitInterface(context);
    this.emitStruct(context);
    this.emitGetters(context);

    if (this.initializer) {
      this.initializer.emit(context);
    }

    this.emitSetters(context);

    for (const method of this.staticMethods) {
      method.emit(context);
    }

    for (const prop of this.staticProperties) {
      this.emitStaticProperty(context, prop);
    }

    for (const method of this.methods) {
      method.emit(context);
    }

    for (const method of this.reimplementedMethods ?? []) {
      method.emit(context);
    }
  }

  public emitRegistration(code: CodeMaker): void {
    code.open(`${JSII_RT_ALIAS}.RegisterClass(`);
    code.line(`"${this.fqn}",`);
    code.line(`reflect.TypeOf((*${this.name})(nil)).Elem(),`);
    this.emitProxyMakerFunction(code, this.baseTypes);
    code.close(')');
  }

  public get usesInitPackage() {
    return (
      this.initializer != null ||
      this.methods.some((m) => m.usesInitPackage) ||
      this.properties.some((p) => p.usesInitPackage)
    );
  }

  public get usesRuntimePackage() {
    return (
      this.initializer != null ||
      this.methods.length > 0 ||
      this.properties.length > 0
    );
  }

  protected emitInterface(context: EmitContext): void {
    const { code, documenter } = context;
    documenter.emit(this.type.docs);
    code.openBlock(`type ${this.name} interface`);

    // embed extended interfaces
    if (this.extends) {
      code.line(
        new GoTypeRef(
          this.pkg.root,
          this.extends.type.reference,
        ).scopedInterfaceName(this.pkg),
      );
    }
    for (const iface of this.implements) {
      code.line(
        new GoTypeRef(this.pkg.root, iface.type.reference).scopedInterfaceName(
          this.pkg,
        ),
      );
    }

    for (const property of this.properties) {
      property.emitGetterDecl(context);
      property.emitSetterDecl(context);
    }

    for (const method of this.methods) {
      method.emitDecl(context);
    }

    code.closeBlock();
    code.line();
  }

  private emitGetters(context: EmitContext) {
    if (this.properties.length === 0) {
      return;
    }
    for (const property of this.properties) {
      property.emitGetterProxy(context);
    }
    for (const property of this.reimplementedProperties ?? []) {
      property.emitGetterProxy(context);
    }
    context.code.line();
  }

  private emitStruct({ code }: EmitContext): void {
    code.line(`// The jsii proxy struct for ${this.name}`);
    code.openBlock(`type ${this.proxyName} struct`);
    if (this.extends == null && this.implements.length === 0) {
      // Make sure this is not 0-width
      code.line('_ byte // padding');
    } else {
      if (this.extends) {
        const embed =
          this.extends.pkg === this.pkg
            ? this.extends.proxyName
            : new GoTypeRef(
                this.pkg.root,
                this.extends.type.reference,
              ).scopedInterfaceName(this.pkg);
        code.line(`${embed} // extends ${this.extends.fqn}`);
      }
      for (const iface of this.implements) {
        const embed =
          iface.pkg === this.pkg
            ? iface.proxyName
            : new GoTypeRef(
                this.pkg.root,
                iface.type.reference,
              ).scopedInterfaceName(this.pkg);
        code.line(`${embed} // implements ${iface.fqn}`);
      }
    }
    code.closeBlock();
    code.line();
  }

  private emitStaticProperty({ code }: EmitContext, prop: GoProperty): void {
    const getCaller = new StaticGetProperty(prop);

    const propertyName = toPascalCase(prop.name);
    const name = `${this.name}_${propertyName}`;

    code.openBlock(`func ${name}() ${prop.returnType}`);
    getCaller.emit(code);

    code.closeBlock();
    code.line();

    if (!prop.immutable) {
      const setCaller = new StaticSetProperty(prop);
      const name = `${this.name}_Set${propertyName}`;
      code.openBlock(`func ${name}(val ${prop.returnType})`);
      setCaller.emit(code);

      code.closeBlock();
      code.line();
    }
  }

  // emits the implementation of the setters for the struct
  private emitSetters(context: EmitContext): void {
    for (const property of this.properties) {
      property.emitSetterProxy(context);
    }
    for (const property of this.reimplementedProperties ?? []) {
      property.emitSetterProxy(context);
    }
  }

  public get dependencies(): Package[] {
    // need to add dependencies of method arguments and constructor arguments
    return [
      ...this.baseTypes.map((ref) => ref.pkg),
      ...getMemberDependencies(this.properties),
      ...getMemberDependencies(this.methods),
      ...getParamDependencies(this.methods),
    ];
  }

  /*
   * Get fqns of interfaces the class implements
   */
  public get interfaces(): string[] {
    return this.type.interfaces.map((iFace) => iFace.fqn);
  }
}

export class GoClassConstructor {
  private readonly constructorRuntimeCall: ClassConstructor;
  public readonly parameters: GoParameter[];

  public constructor(
    public readonly parent: GoClass,
    private readonly type: Initializer,
  ) {
    this.constructorRuntimeCall = new ClassConstructor(this);
    this.parameters = this.type.parameters.map(
      (param) => new GoParameter(parent, param),
    );
  }

  public emit(context: EmitContext) {
    const { code } = context;
    const constr = `New${this.parent.name}`;
    const paramString =
      this.parameters.length === 0
        ? ''
        : this.parameters.map((p) => p.toString()).join(', ');

    let docstring = '';
    if (this.type.docs.summary) {
      docstring = this.type.docs.toString();
      code.line(`// ${docstring}`);
    }

    code.openBlock(`func ${constr}(${paramString}) ${this.parent.name}`);

    this.constructorRuntimeCall.emit(code);
    code.closeBlock();
    code.line();
  }
}

export class ClassMethod extends GoMethod {
  public readonly runtimeCall: MethodCall;
  public readonly usesInitPackage: boolean = false;
  public readonly usesRuntimePackage = true;

  public constructor(
    public readonly parent: GoClass,
    public readonly method: Method,
  ) {
    super(parent, method);
    this.runtimeCall = new MethodCall(this);
  }

  /* emit generates method implementation on the class */
  public emit({ code, documenter }: EmitContext) {
    const name = this.name;
    const returnTypeString = this.reference?.void ? '' : ` ${this.returnType}`;

    documenter.emit(this.method.docs);
    code.openBlock(
      `func (${this.instanceArg} *${
        this.parent.proxyName
      }) ${name}(${this.paramString()})${returnTypeString}`,
    );

    this.runtimeCall.emit(code);

    code.closeBlock();
    code.line();
  }

  /* emitDecl generates method declaration in the class interface */
  public emitDecl(context: EmitContext) {
    const { code } = context;
    const returnTypeString = this.reference?.void ? '' : ` ${this.returnType}`;
    code.line(`${this.name}(${this.paramString()})${returnTypeString}`);
  }

  public get returnType(): string {
    return (
      this.reference?.scopedInterfaceName(this.parent.pkg) ??
      this.method.toString()
    );
  }

  public get instanceArg(): string {
    return this.parent.name.substring(0, 1).toLowerCase();
  }
}

export class StaticMethod extends ClassMethod {
  public readonly usesInitPackage = true;

  public constructor(
    public readonly parent: GoClass,
    public readonly method: Method,
  ) {
    super(parent, method);
  }

  public emit({ code, documenter }: EmitContext) {
    const name = `${this.parent.name}_${this.name}`;
    const returnTypeString = this.reference?.void ? '' : ` ${this.returnType}`;

    documenter.emit(this.method.docs);
    code.openBlock(`func ${name}(${this.paramString()})${returnTypeString}`);

    this.runtimeCall.emit(code);

    code.closeBlock();
    code.line();
  }
}
