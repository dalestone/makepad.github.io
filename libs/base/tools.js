var painter = require('services/painter')
//var fingers = require('fingers')
var types = require('base/types')

module.exports = class Tools extends require('base/mixin'){

	static mixin(proto){
		this._mixin(proto)

		proto.Turtle = require('base/turtle')

		Object.defineProperty(proto, 'tools', {
			get:function(){
				throw new Error('Please only assign to tools, use _tools if you need to access the data')
			},
			set:function(tools){
				if(!this.hasOwnProperty('_tools')) this._tools = this._tools?Object.create(this._tools):{}
				for(let key in tools){
					var cls =  tools[key]
					if(cls && cls.constructor === Object){ // subclass it
						this[key] = cls
						continue
					}
					this._tools[key] = true
					this['_' + key] = cls
					defineToolGetterSetter(this, key)
					this.$compileToolMacros(key, cls)
				}	
			}
		})

		Object.defineProperty(proto,'styles',{
			get:function(){ return this._styles },
			set:function(inStyles){
				// rewrite the styles system.
				this._stylesProto = protoInherit(this._stylesProto, inStyles)
				this._styles = protoProcess(this._stylesProto)
			}
		})
	}

	beginLayout(opts){
		var turtle = this.turtle
		if(opts){
			turtle._margin = opts.margin || zeroMargin
			turtle._padding = opts.padding || zeroMargin
			turtle._align = opts.align || zeroAlign
			turtle._wrap = opts.wrap || true
			if(opts.x !== undefined) turtle._x = opts.x
			if(opts.y !== undefined) turtle._y = opts.y
			if(opts.w !== undefined) turtle._w = opts.w
			if(opts.h !== undefined) turtle._h = opts.h
		}
		this.beginTurtle(1)
	}

	endLayout(){
		var ot = this.endTurtle()
		this.turtle.walk(ot)
	}

	beginTurtle(dump){
		var view = this.view
		// add a turtle to the stack
		var len = ++view.$turtleStack.len
		var outer = this.turtle
		var turtle = this.turtle = view.$turtleStack[len]
		if(!turtle){
			turtle = this.turtle = view.$turtleStack[len] = new view.Turtle(view)
		}
		turtle.view = view
		turtle.context = view
		turtle._pickId = outer._pickId
		turtle.begin(outer, dump)
		return turtle
	}

	endTurtle(doBounds){
		// call end on a turtle and pop it off the stack
		var view = this.view
		this.turtle.end(doBounds)
		// pop the stack
		var last = this.turtle
		var outer = this.turtle = view.$turtleStack[--view.$turtleStack.len]
		// forward the pickId back down
		//outer._pickId = last._pickId
		return last
	}

	lineBreak(){
		this.turtle.lineBreak()
	}

	$moveWritten(start, dx, dy){
		var view = this.view
		var writes = view.$writeList
		var current = view.$turtleStack.len
		for(let i = start; i < writes.length; i += 4){
			var props = writes[i]
			var begin = writes[i+1]
			var end = writes[i+2]
			var level = writes[i+3]
			if(current > level) continue
			var slots = props.slots
			var xoff = props.xOffset
			var yoff = props.yOffset
			var array = props.array
			for(let j = begin; j < end; j++){
				array[j * slots + xoff] += dx
				array[j * slots + yoff] += dy
 			}
		}
	}

	setPickId(pickId){
		this.turtle._pickId = pickId
	}

	addPickId(){
		return this.turtle._pickId = ++this.$pickId
	}

	// internal API used by canvas macros
	$allocShader(classname){
		var shaders = this.$shaders
		var proto = new this['_' + classname]()
		
		var info = proto.$compileInfo

		var shader = shaders[classname] = new painter.Shader(info)

		shader.$drawUbo = new painter.Ubo(info.uboDefs.draw)
		var props = shader.$props = new painter.Mesh(info.propSlots)
		// create a vao
		var vao = shader.$vao = new painter.Vao(shader)

		// initialize the VAO
		var geometryProps = info.geometryProps
		var attrbase = painter.nameId('ATTR_0')
		var attroffset = Math.ceil(info.propSlots / 4)

		vao.instances(attrbase, attroffset, props)

		var attrid = attroffset
		// set attributes
		for(let key in geometryProps){
			var geom = geometryProps[key]
			var attrRange = ceil(geom.type.slots / 4)
			vao.attributes(attrbase + attrid, attrRange, proto[geom.name])
			attrid += attrRange
		}

		// check if we have indice
		if(proto.indices){
			vao.indices(proto.indices)
		}

		props.name = this.name + "-"+classname
		var xProp = info.instanceProps.this_DOT_x
		props.xOffset = xProp && xProp.offset
		var yProp = info.instanceProps.this_DOT_y 
		props.yOffset = yProp && yProp.offset
		//var wProp = info.instanceProps.this_DOT_w
		//props.wOffset = wProp && wProp.offset
		//var hProp = info.instanceProps.this_DOT_h
		//props.hOffset = hProp && hProp.offset
		//props.drawDiscard = this.view.drawDiscard || proto.drawDiscard
		props.transferData = proto.transferData
		return shader
	}

	parseColor(str, alpha){
		var out = []
		if(!types.colorFromString(str, alpha, out, 0)){
			console.log("Cannot parse color" + str)
		}
		return out
	}

	$parseColor(str, alpha, a, o){
		if(!types.colorFromString(str, alpha, a, o)){
			console.log("Cannot parse color "+str)
		}
	}

	$parseColorPacked(str, alpha, a, o){
		if(!types.colorFromStringPacked(str, alpha, a, o)){
			console.log("Cannot parse color "+str)
		}
	}

	$compileToolMacros(className, sourceClass){
		var sourceProto = sourceClass.prototype
		var macros = sourceProto._toolMacros

		var target = this
		for(let macroName in macros){
			var methodName = macroName + className
			var thing = macros[macroName]
			
			var cacheKey = sourceProto.$toolCacheKey
			if(false){//cacheKey){
				var cache = fnCache[cacheKey+methodName]
				if(cache){
					target[methodName] = cache
					continue
				}
			}

			if(typeof thing !== 'function'){
				target[methodName] = thing
				continue
			}
			var code = thing.toString().replace(comment1Rx,'').replace(comment2Rx,'')
			// lets parse our args
			var marg = code.match(mainArgRx)
			var mainargs = marg[1].match(argSplitRx) || []
			code = code.replace(macroRx, function(m, indent, fnname, args){
				// if args are not a {
				var macroArgs
				if(typeof args === 'string' && args.indexOf('{') !== -1){
					// lets parse args
					var res, argobj = {}
					while((res = argRx.exec(args)) !== null) {
						argobj[res[1]] = res[2]
					}
					macroArgs = [argobj]
				}
				else macroArgs = args.split(/\s*,\s*/)
				var fn = sourceProto[fnname]
				if(!fn) throw new Error('CanvasMacro: '+fnname+ ' does not exist')
				return sourceProto[fnname](target, className, macroArgs, mainargs, indent)
			})
			code = code.replace(nameRx,className)

			var outcode = code.replace(dumpRx,'')
			if(outcode !== code){
				code = outcode
			}
			
			code = code.replace(fnnameRx, function(){
				return 'function '+methodName+'('
			})

			// create the function on target
			target[methodName] = fnCache[code] || (fnCache[code] = new Function('return ' + code)())

			if(cacheKey){ // store it
				fnCache[cacheKey+methodName] = target[methodName]
			}
		}
	}
}


function defineToolGetterSetter(proto, key){
	Object.defineProperty(proto, key, {
		configurable:true,
		get:function(){
			var cls = this['_' + key]
			cls.outer = this
			return cls
		},
		set:function(prop){
			var base = this['_' + key]
			var cls = this['_' + key] = base.extend(prop)
			this.$compileToolMacros(key, cls)
		}
	})
}


// creates a prototypical inheritance overload from an object
function protoInherit(oldobj, newobj){
	// copy oldobj
	var outobj = oldobj?Object.create(oldobj):{}
	// copy old object subobjects
	for(let key in oldobj){
		var item = oldobj[key]
		if(item && item.constructor === Object){
			outobj[key] = protoInherit(item, newobj && newobj[key])
		}
	}
	// overwrite new object
	for(let key in newobj){
		var item = newobj[key]
		if(item && item.constructor === Object){
			outobj[key] = protoInherit(oldobj && oldobj[key], newobj && newobj[key])
		}
		else{
			if(typeof item === 'string' && item.charAt(0) === '#'){
				item = module.exports.prototype.parseColor(item,1)
			}
			outobj[key] = item
		}
	}
	return outobj
}

// we have to return a new objectect
function protoProcess(base, ovl, parent, incpy){
	var cpy = incpy
	var out = {_:parent}
	// make sure our copy props are read first
	for(let key in base){
		var value = base[key]
		var $index = key.indexOf('$')
		if($index === 0){
			cpy = cpy?cpy === incpy?Object.create(cpy):cpy:{}
			cpy[key.slice(1)] = value
		}
	}
	for(let key in ovl){
		var value = ovl[key]
		var $index = key.indexOf('$')
		if($index === 0){
			cpy = cpy?cpy === incpy?Object.create(cpy):cpy:{}
			cpy[key.slice(1)] = value
		}
	}
	for(let key in base){
		if(key === '_') continue
		var value = base[key]
		var $index = key.indexOf('$')
		if($index === 0){}
		else if($index >0){
			var keys = key.split('$')
			var o = out, bc = keys[1]
			while(o && !o[bc]) o = o._
			out[keys[0]] = protoProcess(o && o[bc], value, out, cpy)
		}
		else if(value && value.constructor === Object){
			out[key] = protoProcess(value, null, out, cpy)
		}
		else{
			out[key] = value
		}
	}
	for(let key in ovl){
		if(key === '_') continue
		var value = ovl[key]
		var $index = key.indexOf('$')
		if($index === 0){ }
		else if($index>0){
			var keys = key.split('$')
			var o = out, bc = keys[1]
			while(o && !o[bc]) o = o._
			out[keys[0]] = protoProcess(out[keys[0]], protoProcess(o && o[bc], value, out, cpy), out, cpy)
		}
		else if(value && value.constructor === Object){
			out[key] = protoProcess(out[key], value, out, cpy)
		}
		else{
			out[key] = value
		}
	}
	for(let key in cpy){
		out[key] = cpy[key]
	}
	return out
}
var argRx = new RegExp(/([a-zA-Z\_\$][a-zA-Z0-9\_\$]*)\s*\:\s*([^\,\}]+)/g)
var comment1Rx = new RegExp(/\/\*[\S\s]*?\*\//g)
var comment2Rx = new RegExp(/\/\/[^\n]*/g)
var mainArgRx = new RegExp(/function\s*[a-zA-Z\_\$]*\s*\(([^\)]*)/)
var macroRx = new RegExp(/([\t]*)this\.([\$][A-Z][A-Z0-9\_]*)\s*\(([^\)]*)\)/g)
var argSplitRx = new RegExp(/[^,\s]+/g)
var nameRx = new RegExp(/NAME/g)
var fnnameRx = new RegExp(/^function\s*\(/)
var dumpRx = new RegExp(/DUMP/g)

var fnCache = {}
var zeroMargin = [0,0,0,0]
var zeroAlign = [0,0]
