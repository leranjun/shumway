/**
 * Copyright 2014 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

module Shumway.GFX.GL {
  import Color = Shumway.Color;
  var SCRATCH_CANVAS_SIZE = 1024 * 2;
  export var TILE_SIZE = 256;
  var MIN_UNTILED_SIZE = 512;

  function getTileSize(bounds: Rectangle): number {
    if (bounds.w < TILE_SIZE || bounds.h < TILE_SIZE) {
      return Math.min(bounds.w, bounds.h);
    }
    return TILE_SIZE;
  }

  var MIN_CACHE_LEVELS = 6;
  var MAX_CACHE_LEVELS = 6;

  var release = true;
  export var writer: IndentingWriter = null;
  export var timeline: Timeline = null;

  import Point = Shumway.Geometry.Point;
  import Point3D = Shumway.Geometry.Point3D;
  import Matrix = Shumway.Geometry.Matrix;
  import Matrix3D = Shumway.Geometry.Matrix3D;
  import Rectangle = Shumway.Geometry.Rectangle;
  import RegionAllocator = Shumway.Geometry.RegionAllocator;

  import Frame = Shumway.GFX.Frame;
  import Stage = Shumway.GFX.Stage;
  import Shape = Shumway.GFX.Shape;
  import SolidRectangle = Shumway.GFX.SolidRectangle;
  import Filter = Shumway.GFX.Filter;
  import BlurFilter = Shumway.GFX.BlurFilter;
  import ColorMatrix = Shumway.GFX.ColorMatrix;
  import VisitorFlags = Shumway.GFX.VisitorFlags;

  import TileCache = Shumway.Geometry.TileCache;
  import Tile = Shumway.Geometry.Tile;
  import OBB = Shumway.Geometry.OBB;

  import radianToDegrees = Shumway.Geometry.radianToDegrees;
  import degreesToRadian = Shumway.Geometry.degreesToRadian;

  import clamp = Shumway.NumberUtilities.clamp;
  import pow2 = Shumway.NumberUtilities.pow2;

  function getAbsoluteSourceBounds(source: IRenderable): Rectangle {
    var bounds = source.getBounds().clone();
    bounds.offset(-bounds.x, -bounds.y);
    return bounds;
  }

  export class Vertex extends Shumway.Geometry.Point3D {
    constructor (x: number, y: number, z: number) {
      super(x, y, z);
    }
    static createEmptyVertices<T extends Vertex>(type: new (x: number, y: number, z: number) => T, count: number): T [] {
      var result = [];
      for (var i = 0; i < count; i++) {
        result.push(new type(0, 0, 0));
      }
      return result;
    }
  }

  export class WebGLTextureRegion implements ILinkedListNode<WebGLTextureRegion> {
    texture: WebGLTexture;
    region: RegionAllocator.Region;
    uses: number = 0;
    next: WebGLTextureRegion;
    previous: WebGLTextureRegion;
    constructor(texture: WebGLTexture, region: RegionAllocator.Region) {
      this.texture = texture;
      this.region = region;
      this.texture.regions.push(this);
      this.next = this.previous = null;
    }
  }

  export class WebGLTextureAtlas {
    texture: WebGLTexture;

    private _context: WebGLContext;
    private _regionAllocator: RegionAllocator.IRegionAllocator;
    private _w: number;
    private _h: number;
    private _compact: boolean;

    get compact(): boolean {
      return this._compact;
    }

    get w(): number {
      return this._w;
    }

    get h(): number {
      return this._h;
    }

    constructor(context: WebGLContext, texture: WebGLTexture, w: number, h: number, compact: boolean) {
      this._context = context;
      this.texture = texture;
      this._w = w;
      this._h = h;
      this._compact = compact;
      this.reset();
    }

    add(image: any, w: number, h: number): RegionAllocator.Region {
      var gl = this._context.gl;
      var region = this._regionAllocator.allocate(w, h);
      if (!region) {
        return;
      }
      if (image) {
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        timeline && timeline.enter("texSubImage2D");
        gl.texSubImage2D(gl.TEXTURE_2D, 0, region.x, region.y, gl.RGBA, gl.UNSIGNED_BYTE, image);
        traceLevel >= TraceLevel.Verbose && writer.writeLn("texSubImage2D: " + region);
        timeline && timeline.leave("texSubImage2D");
        count("texSubImage2D");
      }
      return region;
    }

    remove(region: RegionAllocator.Region) {
      this._regionAllocator.free(region);
    }

    reset() {
      if (this._compact) {
        this._regionAllocator = new RegionAllocator.Compact(this._w, this._h);
      } else {
        this._regionAllocator = new RegionAllocator.Grid(this._w, this._h, TILE_SIZE);
      }
    }
  }

  export class WebGLStageRendererOptions extends StageRendererOptions {

  }

  export class WebGLStageRenderer extends StageRenderer {
    context: WebGLContext;
    private _viewport: Rectangle;

    private _brush: WebGLCombinedBrush;
    private _brushGeometry: WebGLGeometry;

    private _stencilBrush: WebGLCombinedBrush;
    private _stencilBrushGeometry: WebGLGeometry;

    private _tmpVertices: Vertex [] = Vertex.createEmptyVertices(Vertex, 64);

    private _scratchCanvas: HTMLCanvasElement;
    private _scratchCanvasContext: CanvasRenderingContext2D;
    private _dynamicScratchCanvas: HTMLCanvasElement;
    private _dynamicScratchCanvasContext: CanvasRenderingContext2D;
    private _uploadCanvas: HTMLCanvasElement;
    private _uploadCanvasContext: CanvasRenderingContext2D;

    constructor(canvas: HTMLCanvasElement, stage: Stage,
                options: WebGLStageRendererOptions = new WebGLStageRendererOptions()) {
      super(canvas, stage);
      var context = this.context = null; // context;
      var w  = 0, h = 0;
      this._viewport = new Rectangle(0, 0, w, h);
      this._brushGeometry = new WebGLGeometry(context);
      this._brush = new WebGLCombinedBrush(context, this._brushGeometry);

      this._stencilBrushGeometry = new WebGLGeometry(context);
      this._stencilBrush = new WebGLCombinedBrush(context, this._stencilBrushGeometry);

      this._scratchCanvas = document.createElement("canvas");
      this._scratchCanvas.width = this._scratchCanvas.height = SCRATCH_CANVAS_SIZE;
      this._scratchCanvasContext = this._scratchCanvas.getContext("2d", {
        willReadFrequently: true
      });

      this._dynamicScratchCanvas = document.createElement("canvas");
      this._dynamicScratchCanvas.width = this._dynamicScratchCanvas.height = 0;
      this._dynamicScratchCanvasContext = this._dynamicScratchCanvas.getContext("2d", {
        willReadFrequently: true
      });

      this._uploadCanvas = document.createElement("canvas");
      this._uploadCanvas.width = this._uploadCanvas.height = 0;
      this._uploadCanvasContext = this._uploadCanvas.getContext("2d", {
        willReadFrequently: true
      });

      // document.getElementById("debugContainer").appendChild(this._uploadCanvas);
      // document.getElementById("debugContainer").appendChild(this._scratchCanvas);
    }

    private _cachedTiles = [];

    public render(stage: Stage, options: any) {

      // TODO: Only set the camera once, not every frame.
      if (options.perspectiveCamera) {
        this.context.modelViewProjectionMatrix = this.context.createPerspectiveMatrix (
          options.perspectiveCameraDistance,
          options.perspectiveCameraFOV,
          options.perspectiveCameraAngle
        );
      } else {
        this.context.modelViewProjectionMatrix = this.context.create2DProjectionMatrix();
      }

      var that = this;
      var context = this.context;

      var brush = this._brush;

      var viewport = this._viewport;
      if (options.ignoreViewport) {
        viewport = Rectangle.createSquare(1024 * 1024);
      }

      var self = this;
      var inverseTransform = Matrix.createIdentity();

      function cacheImageCallback(oldTextureRegion: WebGLTextureRegion, src: CanvasRenderingContext2D, srcBounds: Rectangle): WebGLTextureRegion {
        /*
         * To avoid seeming caused by linear texture sampling we need to pad each atlased image with a 1 pixel border that duplicates
         * edge pixels, similar to CLAMP_TO_EDGE
         *
         * See the discussion here: http://gamedev.stackexchange.com/questions/61796/sprite-sheet-textures-picking-up-edges-of-adjacent-texture
         *
         * For the image:
         *
         *    +---+
         *    |123|
         *    |456|
         *    |789|
         *    +---+
         *
         * We instead create:
         *
         *  +-------+
         *  |? 123 ?|
         *  | +---+ |
         *  |1|123|3|
         *  |4|456|6|
         *  |7|789|9|
         *  | +---+ |
         *  |? 789 ?|
         *  +-------+
         *
         *  I don't know what to do about corners yet. Might not be a problem, I don't see any artifacts if they are left empty.
         */

        var w  = srcBounds.w;
        var h  = srcBounds.h;
        var sx = srcBounds.x;
        var sy = srcBounds.y;

        self._uploadCanvas.width  = w + 2;
        self._uploadCanvas.height = h + 2;

        // Draw Image
        self._uploadCanvasContext.drawImage(src.canvas, sx, sy,         w, h, 1, 1,     w, h);

        // Top & Bottom Margins
        self._uploadCanvasContext.drawImage(src.canvas, sx, sy,         w, 1, 1, 0,     w, 1);
        self._uploadCanvasContext.drawImage(src.canvas, sx, sy + h - 1, w, 1, 1, h + 1, w, 1);

        // Left & Right Margins
        self._uploadCanvasContext.drawImage(src.canvas, sx,         sy, 1, h, 0,     1, 1, h);
        self._uploadCanvasContext.drawImage(src.canvas, sx + w - 1, sy, 1, h, w + 1, 1, 1, h);

        if (!oldTextureRegion) {
          return context.cacheImage(self._uploadCanvas);
        } else {
          if (!options.disableTextureUploads) {
            context.updateTextureRegion(self._uploadCanvas, oldTextureRegion);
          }
          return oldTextureRegion;
        }
      }

      var gl = context.gl;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      var depth = 0;

      brush.reset();

      var parent = null;
      var tileTransform = Matrix.createIdentity();
      var colorTransform = ColorMatrix.createIdentity();
      stage.visit(function (frame: Frame, transform?: Matrix): VisitorFlags {
        if (frame._parent !== parent) {
          parent = frame._parent;
          depth += options.frameSpacing;
        }

        var alpha = frame.getConcatenatedAlpha();
        if (!options.ignoreColorMatrix) {
          colorTransform = frame.getConcatenatedColorMatrix();
        }
        // that.context.setTransform(transform);
        if (frame instanceof SolidRectangle) {
          brush.fillRectangle(frame.getBounds(), Color.parseColor((<SolidRectangle>frame).fillStyle), transform, depth);
        } else if (frame instanceof Shape) {
          var shape = <Shape>frame;
          var bounds = getAbsoluteSourceBounds(shape.source);
          if (!bounds.isEmpty()) {
            var source = shape.source;
            var tileCache: RenderableTileCache = source.properties["tileCache"];
            if (!tileCache) {
              tileCache = source.properties["tileCache"] = new RenderableTileCache(source);
            }
            transform.inverse(inverseTransform);
            var tiles = tileCache.fetchTiles(viewport, inverseTransform, that._scratchCanvasContext, cacheImageCallback);
            for (var i = 0; i < tiles.length; i++) {
              var tile = tiles[i];
              tileTransform.setIdentity();
              tileTransform.translate(tile.bounds.x, tile.bounds.y);
              tileTransform.scale(1 / tile.scale, 1 / tile.scale);
              tileTransform.concat(transform);
              var src = <WebGLTextureRegion>(tile.cachedTextureRegion);
              if (src && src.texture) {
                context.textureRegionCache.put(src);
              }
              if (!brush.drawImage(src, new Rectangle(0, 0, tile.bounds.w, tile.bounds.h), new Color(1, 1, 1, alpha), colorTransform, tileTransform, depth)) {
                unexpected();
              }
              if (options.drawTiles) {
                var srcBounds = tile.bounds.clone();
                if (!tile.color) {
                  tile.color = Color.randomColor(0.2);
                }
                brush.fillRectangle(new Rectangle(0, 0, srcBounds.w, srcBounds.h), tile.color, tileTransform, depth);
              }
            }
          }
        }
        return VisitorFlags.Continue;
      }, stage.matrix);

      brush.flush(options.drawElements);

      if (options.drawTextures) {
        var textures = context.getTextures();
        var transform = Matrix.createIdentity();
        if (options.drawTexture >= 0 && options.drawTexture < textures.length) {
          var texture = textures[options.drawTexture | 0];
          brush.drawImage(new WebGLTextureRegion(texture, <RegionAllocator.Region>new Rectangle(0, 0, texture.w, texture.h)), viewport, Color.White, null, transform, 0.2);
        } else {
          var textureWindowSize = viewport.w / 5;
          if (textureWindowSize > viewport.h / textures.length) {
            textureWindowSize = viewport.h / textures.length;
          }
          brush.fillRectangle(new Rectangle(viewport.w - textureWindowSize, 0, textureWindowSize, viewport.h), new Color(0, 0, 0, 0.5), transform, 0.1);
          for (var i = 0; i < textures.length; i++) {
            var texture = textures[i];
            var textureWindow = new Rectangle(viewport.w - textureWindowSize, i * textureWindowSize, textureWindowSize, textureWindowSize);
            brush.drawImage(new WebGLTextureRegion(texture, <RegionAllocator.Region>new Rectangle(0, 0, texture.w, texture.h)), textureWindow, Color.White, null, transform, 0.2);
          }
        }
        brush.flush(options.drawElements);
      }
    }
  }

  export class RenderableTileCache {
    cache: TileCache;
    source: IRenderable;
    cacheLevels: TileCache [] = [];
    constructor(source: IRenderable) {
      this.source = source;
    }

    /**
     * Gets the tiles covered by the specified |query| rectangle and transformed by the given |transform| matrix.
     */
    private getTiles(query: Rectangle, transform: Matrix, scratchBounds: Rectangle): Tile [] {
      var transformScale = Math.max(transform.getAbsoluteScaleX(), transform.getAbsoluteScaleY());
      // Use log2(1 / transformScale) to figure out the tile level.
      var level = 0;
      if (transformScale !== 1) {
        level = clamp(Math.round(Math.log(1 / transformScale) / Math.LN2), -MIN_CACHE_LEVELS, MAX_CACHE_LEVELS);
      }
      var scale = pow2(level);
      // Since we use a single tile for dynamic sources, we've got to make sure that it fits in our texture caches ...

      if (this.source.isDynamic) {
        // .. so try a lower scale level until it fits.
        while (true) {
          scale = pow2(level);
          if (scratchBounds.contains(getAbsoluteSourceBounds(this.source).clone().scale(scale, scale))) {
            break;
          }
          level --;
          assert (level >= -MIN_CACHE_LEVELS);
        }
      }
      // If the source is not scalable don't cache any tiles at a higher scale factor. However, it may still make
      // sense to cache at a lower scale factor in case we need to evict larger cached images.
      if (!this.source.isScalable) {
        level = clamp(level, -MIN_CACHE_LEVELS, 0);
      }
      var scale = pow2(level);
      var levelIndex = MIN_CACHE_LEVELS + level;
      var cache = this.cacheLevels[levelIndex];
      if (!cache) {
        var bounds = getAbsoluteSourceBounds(this.source);
        var scaledBounds = bounds.clone().scale(scale, scale);
        var tileW, tileH;
        if (this.source.isDynamic || !this.source.isTileable || Math.max(scaledBounds.w, scaledBounds.h) <= MIN_UNTILED_SIZE) {
          tileW = scaledBounds.w;
          tileH = scaledBounds.h;
        } else {
          tileW = tileH = TILE_SIZE;
        }
        cache = this.cacheLevels[levelIndex] = new TileCache(scaledBounds.w, scaledBounds.h, tileW, tileH, scale);
      }
      return cache.getTiles(query, transform.scaleClone(scale, scale));
    }

    fetchTiles (
      query: Rectangle,
      transform: Matrix,
      scratchContext: CanvasRenderingContext2D,
      cacheImageCallback: (old: WebGLTextureRegion, src: CanvasRenderingContext2D, srcBounds: Rectangle) => WebGLTextureRegion): Tile []  {
      var scratchBounds = new Rectangle(0, 0, scratchContext.canvas.width, scratchContext.canvas.height);
      var tiles = this.getTiles(query, transform, scratchBounds);
      var uncachedTiles: Tile [];
      var source = this.source;
      for (var i = 0; i < tiles.length; i++) {
        var tile = tiles[i];
        if (!tile.cachedTextureRegion || !tile.cachedTextureRegion.texture || (source.isDynamic && source.isInvalid)) {
          if (!uncachedTiles) {
            uncachedTiles = [];
          }
          uncachedTiles.push(tile);
        }
      }
      if (uncachedTiles) {
        this.cacheTiles(scratchContext, uncachedTiles, cacheImageCallback, scratchBounds);
      }
      return tiles;
    }

    private getTileBounds(tiles: Tile []): Rectangle {
      var bounds = Rectangle.createEmpty();
      for (var i = 0; i < tiles.length; i++) {
        bounds.union(tiles[i].bounds);
      }
      return bounds;
    }

    /**
     * This caches raster versions of the specified |uncachedTiles| in GPU textures. The tiles are generated
     * using a scratch canvas2D context (|scratchContext|) and then uploaded to the GPU via |cacheImageCallback|.
     * Ideally, we want to render all tiles in one go, but they may not fit in the |scratchContext| in which case
     * we need to render the source shape several times.
     *
     * TODO: Find a good algorithm to do this since it's quite important that we don't repaint too many times.
     * Spending some time trying to figure out the *optimal* solution may pay-off since painting is soo expensive.
     */

    private cacheTiles (
      scratchContext: CanvasRenderingContext2D,
      uncachedTiles: Tile [],
      cacheImageCallback: (old: WebGLTextureRegion, src: CanvasRenderingContext2D, srcBounds: Rectangle) => WebGLTextureRegion,
      scratchBounds: Rectangle,
      maxRecursionDepth: number = 4) {
      assert (maxRecursionDepth > 0, "Infinite recursion is likely.");
      var uncachedTileBounds = this.getTileBounds(uncachedTiles);
      scratchContext.save();
      scratchContext.setTransform(1, 0, 0, 1, 0, 0);
      scratchContext.clearRect(0, 0, scratchBounds.w, scratchBounds.h);
      scratchContext.translate(-uncachedTileBounds.x, -uncachedTileBounds.y);
      scratchContext.scale(uncachedTiles[0].scale, uncachedTiles[0].scale);
      timeline && timeline.enter("renderTiles");
      traceLevel >= TraceLevel.Verbose && writer.writeLn("Rendering Tiles: " + uncachedTileBounds);
      this.source.render(scratchContext);
      scratchContext.restore();
      timeline && timeline.leave("renderTiles");

      var remainingUncachedTiles = null;
      for (var i = 0; i < uncachedTiles.length; i++) {
        var tile = uncachedTiles[i];
        var region = tile.bounds.clone();
        region.x -= uncachedTileBounds.x;
        region.y -= uncachedTileBounds.y;
        if (!scratchBounds.contains(region)) {
          if (!remainingUncachedTiles) {
            remainingUncachedTiles = [];
          }
          remainingUncachedTiles.push(tile);
        }
        tile.cachedTextureRegion = cacheImageCallback(<WebGLTextureRegion>tile.cachedTextureRegion, scratchContext, region);
      }
      if (remainingUncachedTiles) {
        // This is really dumb at the moment; if we have some tiles left over, partition the tile set in half and recurse.
        if (remainingUncachedTiles.length >= 2) {
          var a = remainingUncachedTiles.slice(0, remainingUncachedTiles.length / 2 | 0);
          var b = remainingUncachedTiles.slice(a.length);
          this.cacheTiles(scratchContext, a, cacheImageCallback, scratchBounds, maxRecursionDepth - 1);
          this.cacheTiles(scratchContext, b, cacheImageCallback, scratchBounds, maxRecursionDepth - 1);
        } else {
          this.cacheTiles(scratchContext, remainingUncachedTiles, cacheImageCallback, scratchBounds, maxRecursionDepth - 1);
        }
      }
    }
  }

  export class WebGLBrush {
    context: WebGLContext;
    geometry: WebGLGeometry;
    constructor(context: WebGLContext, geometry: WebGLGeometry) {
      this.context = context;
      this.geometry = geometry;
    }
  }

  export enum WebGLCombinedBrushKind {
    FillColor,
    FillTexture,
    FillTextureWithColorMatrix
  }

  export class WebGLCombinedBrushVertex extends Vertex {
    static attributeList: WebGLAttributeList;
    static initializeAttributeList(context) {
      var gl = context.gl;
      if (WebGLCombinedBrushVertex.attributeList) {
        return;
      }
      WebGLCombinedBrushVertex.attributeList = new WebGLAttributeList([
        new WebGLAttribute("aPosition", 3, gl.FLOAT),
        new WebGLAttribute("aCoordinate", 2, gl.FLOAT),
        new WebGLAttribute("aColor", 4, gl.UNSIGNED_BYTE, true),
        new WebGLAttribute("aKind", 1, gl.FLOAT),
        new WebGLAttribute("aSampler", 1, gl.FLOAT)
      ]);
      WebGLCombinedBrushVertex.attributeList.initialize(context);
    }
    kind: WebGLCombinedBrushKind = WebGLCombinedBrushKind.FillColor;
    color: Color = new Color(0, 0, 0, 0);
    sampler: number = 0;
    coordinate: Point = new Point(0, 0);
    constructor (x: number, y: number, z: number) {
      super(x, y, z);
    }
    public writeTo(geometry: WebGLGeometry) {
      var array = geometry.array;
      array.ensureAdditionalCapacity(68);
      array.writeVertex3DUnsafe(this.x, this.y, this.z);
      array.writeVertexUnsafe(this.coordinate.x, this.coordinate.y);
      array.writeColorUnsafe(this.color.r * 255, this.color.g * 255, this.color.b * 255, this.color.a * 255);
      array.writeFloatUnsafe(this.kind);
      array.writeFloatUnsafe(this.sampler);
    }
  }


  export class WebGLCombinedBrush extends WebGLBrush {
    private static _tmpVertices: WebGLCombinedBrushVertex [] = Vertex.createEmptyVertices(WebGLCombinedBrushVertex, 4);
    private _program: WebGLProgram;
    private _textures: WebGLTexture [];
    private _colorTransform: ColorMatrix;
    private static _depth: number = 1;
    constructor(context: WebGLContext, geometry: WebGLGeometry) {
      super(context, geometry);
      this._program = context.createProgramFromFiles("combined.vert", "combined.frag");
      this._textures = [];
      WebGLCombinedBrushVertex.initializeAttributeList(this.context);
    }

    public reset() {
      this._textures = [];
      this.geometry.reset();
    }

    public drawImage(src: WebGLTextureRegion, dstRectangle: Rectangle, color: Color, colorTransform: ColorMatrix, transform: Matrix, depth: number = 0): boolean {
      if (!src || !src.texture) {
        return true;
      }
      dstRectangle = dstRectangle.clone();
      if (this._colorTransform) {
        if (!colorTransform || !this._colorTransform.equals(colorTransform)) {
          this.flush();
        }
      }
      this._colorTransform = colorTransform;
      var sampler = this._textures.indexOf(src.texture);
      if (sampler < 0) {
        if (this._textures.length === 8) {
          this.flush();
        }
        this._textures.push(src.texture);
        // if (this._textures.length > 8) {
        //   return false;
        //   notImplemented("Cannot handle more than 8 texture samplers.");
        // }
        sampler = this._textures.length - 1;
      }
      var tmpVertices = WebGLCombinedBrush._tmpVertices;
      var srcRectangle = src.region.clone();

      // TODO: This takes into the consideration the 1 pixel border added around tiles in the atlas. It should
      // probably be moved elsewhere.
      srcRectangle.offset(1, 1).resize(-2, -2);
      srcRectangle.scale(1 / src.texture.w, 1 / src.texture.h);
      transform.transformRectangle(dstRectangle, <Point[]><any>tmpVertices);
      for (var i = 0; i < 4; i++) {
        tmpVertices[i].z = depth;
      }
      tmpVertices[0].coordinate.x = srcRectangle.x;
      tmpVertices[0].coordinate.y = srcRectangle.y;
      tmpVertices[1].coordinate.x = srcRectangle.x + srcRectangle.w;
      tmpVertices[1].coordinate.y = srcRectangle.y;
      tmpVertices[2].coordinate.x = srcRectangle.x + srcRectangle.w;
      tmpVertices[2].coordinate.y = srcRectangle.y + srcRectangle.h;
      tmpVertices[3].coordinate.x = srcRectangle.x;
      tmpVertices[3].coordinate.y = srcRectangle.y + srcRectangle.h;

//      for (var i = 0; i < 4; i++) {
//        tmpVertices[i].x = tmpVertices[i].x | 0;
//        tmpVertices[i].y = tmpVertices[i].y | 0;
//      }

      for (var i = 0; i < 4; i++) {
        var vertex = WebGLCombinedBrush._tmpVertices[i];
        vertex.kind = colorTransform ?
          WebGLCombinedBrushKind.FillTextureWithColorMatrix :
        WebGLCombinedBrushKind.FillTexture;
        vertex.color.set(color);
        vertex.sampler = sampler;
        vertex.writeTo(this.geometry);
      }
      this.geometry.addQuad();
      return true;
    }

    public fillRectangle(rectangle: Rectangle, color: Color, transform: Matrix, depth: number = 0) {
      transform.transformRectangle(rectangle, <Point[]><any>WebGLCombinedBrush._tmpVertices);
      for (var i = 0; i < 4; i++) {
        var vertex = WebGLCombinedBrush._tmpVertices[i];
        vertex.kind = WebGLCombinedBrushKind.FillColor;
        vertex.color.set(color);
        vertex.z = depth;
        vertex.writeTo(this.geometry);
      }
      this.geometry.addQuad();
    }

    public flush(drawElements: boolean = true) {
      var g = this.geometry;
      var p = this._program;
      var gl = this.context.gl;

      g.uploadBuffers();
      gl.useProgram(p);
      gl.uniformMatrix4fv(p.uniforms.uTransformMatrix3D.location, false, this.context.modelViewProjectionMatrix.asWebGLMatrix());
      if (this._colorTransform) {
        gl.uniformMatrix4fv(p.uniforms.uColorMatrix.location, false, this._colorTransform.asWebGLMatrix());
        gl.uniform4fv(p.uniforms.uColorVector.location, this._colorTransform.asWebGLVector());
      }
      // Bind textures.
      for (var i = 0; i < this._textures.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, this._textures[i]);
      }
      gl.uniform1iv(p.uniforms["uSampler[0]"].location, [0, 1, 2, 3, 4, 5, 6, 7]);
      // Bind vertex buffer.
      gl.bindBuffer(gl.ARRAY_BUFFER, g.buffer);
      var size = WebGLCombinedBrushVertex.attributeList.size;
      var attributeList = WebGLCombinedBrushVertex.attributeList;
      var attributes: WebGLAttribute [] = attributeList.attributes;
      for (var i = 0; i < attributes.length; i++) {
        var attribute = attributes[i];
        var position = p.attributes[attribute.name].location;
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, attribute.size, attribute.type, attribute.normalized, size, attribute.offset);
      }
      // Bind elements buffer.
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.elementBuffer);
      if (drawElements) {
        gl.drawElements(gl.TRIANGLES, g.triangleCount * 3, gl.UNSIGNED_SHORT, 0);
      }
      this.reset();
    }
  }
}