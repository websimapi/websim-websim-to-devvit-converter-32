import * as acorn from 'https://esm.sh/acorn@8.11.3';
import { simple as walkSimple } from 'https://esm.sh/acorn-walk@8.3.2';
import MagicString from 'https://esm.sh/magic-string@0.30.5';

// Helper: Clean Filename
export const cleanName = (name) => {
    const parts = name.toLowerCase().split('.');
    const ext = parts.length > 1 ? parts.pop() : '';
    const base = parts.join('.');
    const cleanBase = base.replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return ext ? `${cleanBase}.${ext}` : cleanBase;
};

export function uint8ToString(u8) {
  if (typeof u8 === 'string') return u8;
  if (!(u8 instanceof Uint8Array)) return String(u8 ?? '');
  return new TextDecoder().decode(u8);
}

// --- Asset Analyzer & Rewriter (Vite Logic) ---

export class AssetAnalyzer {
    constructor() {
        this.dependencies = {};
        this.globalShims = new Set();
        this.hasTailwind = false;
        this.urlMap = new Map();
    }

    setExternalMap(map) {
        this.urlMap = map;
    }

    scanForAssets(content) {
        const code = uint8ToString(content);
        const urls = new Set();
        // Look for URLs with media extensions in quotes
        const regex = /["']((?:https?:)?\/\/[^"']+\.(mp3|wav|ogg|flac|aac|png|jpg|jpeg|gif|glb|gltf))["']/gi;
        let match;
        while ((match = regex.exec(code)) !== null) {
            urls.add(match[1]);
        }
        return Array.from(urls);
    }

    // Detects libraries and converts CDN URLs to NPM package names
    // Returns: Clean import source (e.g., 'three')
    normalizeImport(source) {
        if (!source || typeof source !== 'string') return source;
        if (source.startsWith('.') || source.startsWith('/') || source.startsWith('data:') || source.startsWith('blob:')) return source;

        // 1. Remotion Handling
        if (source.includes('@websim/remotion')) {
            this.dependencies['remotion'] = '^4.0.0';
            this.dependencies['@remotion/player'] = '^4.0.0';
            this.dependencies['react'] = '^18.2.0';
            this.dependencies['react-dom'] = '^18.2.0';
            // Route via bridge to handle mixed exports (Player + hooks)
            return '/remotion_bridge';
        }

        // 2. Three.js Handling
        if (source.includes('/three') || source === 'three') {
            this.dependencies['three'] = '^0.160.0';
            
            // Handle Addons (OrbitControls, GLTFLoader, etc.)
            // Detect "examples/jsm" or "addons"
            if (source.includes('examples/jsm') || source.includes('addons') || source.includes('controls')) {
                // Try to extract the path after 'jsm'
                const match = source.match(/(?:examples\/jsm|addons)\/(.+)/);
                if (match) {
                    let suffix = match[1];
                    // Strip query params if any
                    suffix = suffix.split('?')[0];
                    if (!suffix.endsWith('.js')) suffix += '.js';
                    return `three/examples/jsm/${suffix}`;
                }
            }
            return 'three';
        }

        // 2. Tween.js
        if (source.toLowerCase().includes('tween')) {
            this.dependencies['@tweenjs/tween.js'] = '^23.1.0';
            return '@tweenjs/tween.js';
        }

        // 3. Pixi.js
        if (source.toLowerCase().includes('pixi')) {
            this.dependencies['pixi.js'] = '^7.0.0';
            return 'pixi.js';
        }
        
        // 3.5 React CDN Runtime Fix
        if (source.includes('react')) {
             if (source.includes('jsx-dev-runtime') || source.includes('jsx-runtime')) {
                 this.dependencies['react'] = '^18.2.0';
                 // We preserve the dev-runtime import path so our Vite alias can intercept it with a proxy
                 // Rewriting to jsx-runtime directly breaks code expecting jsxDEV export
                 return source.includes('jsx-dev-runtime') ? 'react/jsx-dev-runtime' : 'react/jsx-runtime';
             }
        }

        // 4. Generic esm.sh / unpkg Handling
        // Capture package name, optional version, AND subpath
        // Updated to handle scoped packages correctly (e.g. @remotion/player)
        const pkgMatch = source.match(/(?:esm\.sh|unpkg\.com|jsdelivr\.net)\/(?:npm\/)?((?:@[^/@]+\/)?[^/@]+)(?:@([^/?]+))?(\/[^?]*)?/);
        if (pkgMatch) {
            const pkg = pkgMatch[1];
            const ver = pkgMatch[2];
            const path = pkgMatch[3] || '';

            // Filter out common non-packages or mistakes
            if (pkg !== 'gh' && pkg !== 'npm') {
                // Update dependency if new or more specific than 'latest'
                const current = this.dependencies[pkg];
                if (!current || (current === 'latest' && ver)) {
                    this.dependencies[pkg] = ver ? `^${ver}` : 'latest';
                }
                // Return package + subpath (e.g. react/jsx-dev-runtime)
                return pkg + path;
            }
        }

        // 5. Bare Specifiers (Import Maps / Node Resolution)
        // If it looks like a package name (no path separators, not a URL), add to dependencies.
        if (!source.match(/^https?:/)) {
            if (source === 'websim') return 'websim'; // Handled by Vite alias, do not add to dependencies

            // Handle scoped packages (@org/pkg) or regular (pkg) potentially followed by /path
            const bareMatch = source.match(/^(@[^/]+\/[^/]+|[^/]+)/);
            if (bareMatch) {
                const pkgName = bareMatch[1];
                
                // Prevent adding scope-only packages (e.g. "@remotion") which cause npm install errors
                if (pkgName.startsWith('@') && !pkgName.includes('/')) {
                    // If it's specifically @remotion, the user might mean 'remotion' package
                    if (pkgName === '@remotion') {
                         if (!this.dependencies['remotion']) this.dependencies['remotion'] = 'latest';
                         return 'remotion';
                    }
                    return source; 
                }

                if (!this.dependencies[pkgName]) {
                    this.dependencies[pkgName] = 'latest';
                }
                return source;
            }
        }
        
        // Return original if we can't map it (Vite might fail, but best effort)
        return source;
    }

    // Rewrites JS imports to use NPM packages
    processJS(jsContent, filename = 'script.js') {
        let code = uint8ToString(jsContent);

        // 1. Identity Hotswap: Replace WebSim avatar URL strings with the client-side user variable
        // This handles cases like `const src = "https://images.websim.ai/avatar/" + user.username`
        // We replace the literal base with the Reddit equivalent or code that uses the Devvit user object
        code = code.replace(/["']https:\/\/images\.websim\.(ai|com)\/avatar\/["']/g, '(window._currentUser?.avatar_url || "https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png")');

        // React/JSX Detection: Ensure dependencies are tracked if JSX is present
        if (/<[A-Z][A-Za-z0-9]*[\s>]/g.test(code) || /className=/g.test(code)) {
            if (!this.dependencies['react']) this.dependencies['react'] = '^18.2.0';
            if (!this.dependencies['react-dom']) this.dependencies['react-dom'] = '^18.2.0';
        }
        
        // (Removed old regex replacements to prevent conflict with AST transformation below)

        // Calculate relative path to root for asset corrections
        const depth = (filename.match(/\//g) || []).length;
        const rootPrefix = depth > 0 ? '../'.repeat(depth) : './';

        let ast;
        const magic = new MagicString(code);
        let hasChanges = false;

        try {
            ast = acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true });
            
            const rewrite = (node) => {
                if (node.source && node.source.value) {
                    const newVal = this.normalizeImport(node.source.value);
                    if (newVal !== node.source.value) {
                        magic.overwrite(node.source.start, node.source.end, JSON.stringify(newVal));
                        hasChanges = true;
                    }
                }
            };

            const rewritePaths = (node) => {
                if (node.type === 'Literal' && typeof node.value === 'string') {
                    const val = node.value;

                    // 1. Check URL Map (Exact Match for external or remapped assets)
                    if (this.urlMap.has(val)) {
                        const cleanName = this.urlMap.get(val);
                        // Serve from root (public folder)
                        const newVal = `/${cleanName}`; 
                        magic.overwrite(node.start, node.end, JSON.stringify(newVal));
                        hasChanges = true;
                        return;
                    }

                    // 2. Handle standard local paths that weren't mapped
                    if (val.startsWith('/') && !val.startsWith('//') && /\.(png|jpg|jpeg|gif|mp3|wav|ogg|glb|gltf|svg|json)$/i.test(val)) {
                        const newVal = rootPrefix + val.substring(1);
                        magic.overwrite(node.start, node.end, JSON.stringify(newVal));
                        hasChanges = true;
                    }
                }
            };

            walkSimple(ast, {
                ImportDeclaration: rewrite,
                ExportNamedDeclaration: rewrite,
                ExportAllDeclaration: rewrite,
                ImportExpression: (node) => {
                    if (node.source.type === 'Literal') {
                        const newVal = this.normalizeImport(node.source.value);
                        if (newVal !== node.source.value) {
                            magic.overwrite(node.source.start, node.source.end, JSON.stringify(newVal));
                            hasChanges = true;
                        }
                    }
                },
                Literal: rewritePaths,
                TemplateLiteral: (node) => {
                    // Smart Swap: Detect Avatar URLs constructed via template literals
                    // Pattern: `https://images.websim.ai/avatar/${username}`
                    if (node.quasis.length >= 1) {
                        const prefix = node.quasis[0].value.raw;
                        if (prefix.includes('images.websim.ai/avatar/') || prefix.includes('images.websim.com/avatar/')) {
                            // If it looks like an avatar URL construction, replace the whole node with a safe fallback or dynamic lookup
                            // If we can identify the user object, great, otherwise use current user or default
                            
                            // Strategy: If it has expressions, it's likely dynamic. 
                            // We replace the whole template literal with a safe Reddit Avatar string.
                            // However, we want to try to use the user's avatar if possible.
                            
                            if (node.expressions.length === 1) {
                                const expr = node.expressions[0];
                                // If `user.username` or `post.username`
                                if (expr.type === 'MemberExpression' && expr.property.name === 'username') {
                                    const objectCode = code.slice(expr.object.start, expr.object.end);
                                    const replacement = `(${objectCode}.avatar_url || "https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png")`;
                                    magic.overwrite(node.start, node.end, replacement);
                                    hasChanges = true;
                                    return;
                                }
                            }
                            
                            // Fallback for simple replacements or complex strings
                            magic.overwrite(node.start, node.end, '"https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png"');
                            hasChanges = true;
                        }
                    }
                }
            });

        } catch (e) {
            // Regex Fallback for JSX or syntax errors (Acorn fails on JSX)
            // Matches:
            // 1. import ... from "..."
            // 2. import "..."
            // 3. export ... from "..."
            // 4. import("...") (dynamic)
            const importRegex = /(import\s+(?:[\w\s{},*]+)\s+from\s+['"])([^'"]+)(['"])|(import\s+['"])([^'"]+)(['"])|(from\s+['"])([^'"]+)(['"])|(import\s*\(\s*['"])([^'"]+)(['"]\s*\))/g;
            let match;
            const originalCode = code; 
            
            while ((match = importRegex.exec(originalCode)) !== null) {
                const url = match[2] || match[5] || match[8] || match[11];
                const prefix = match[1] || match[4] || match[7] || match[10];
                
                if (url) {
                    const newVal = this.normalizeImport(url);
                    if (newVal !== url) {
                        const start = match.index + prefix.length;
                        const end = start + url.length;
                        magic.overwrite(start, end, newVal);
                        hasChanges = true;
                    }
                }
            }
        }

        // Remotion License Injection for <Player /> components
        // We iterate all <Player> tags and ensure the prop is present.
        if (code.includes('<Player')) {
             const playerRegex = /<Player([\s\n\r/>])/g;
             let match;
             while ((match = playerRegex.exec(code)) !== null) {
                 // Check if the prop already exists in the vicinity (heuristic: next 500 chars)
                 // This avoids duplicate injection if the user already added it or if we run multiple times
                 const vicinity = code.slice(match.index, match.index + 500);
                 const closeIndex = vicinity.indexOf('>');
                 const tagContent = closeIndex > -1 ? vicinity.slice(0, closeIndex) : vicinity;
                 
                 if (!tagContent.includes('acknowledgeRemotionLicense')) {
                     // Insert prop right after <Player
                     magic.appendLeft(match.index + 7, ' acknowledgeRemotionLicense={true}');
                     hasChanges = true;
                 }
             }
        }

        return hasChanges ? magic.toString() : code;
    }

    // Process HTML: Remove import maps, extract inline scripts, inject polyfills
    processHTML(htmlContent, filename) {
        let html = uint8ToString(htmlContent);

        // Rewrite Mapped URLs in HTML
        this.urlMap.forEach((cleanName, originalUrl) => {
            // Replace instances of originalUrl with /cleanName
            if (originalUrl && html.includes(originalUrl)) {
                html = html.split(originalUrl).join(`/${cleanName}`);
            }
        });

        const extractedScripts = [];
        let scriptCounter = 0;

        // Ensure DOCTYPE
        if (!html.trim().toLowerCase().startsWith('<!doctype')) {
            html = '<!DOCTYPE html>\n' + html;
        }

        // 1. Remove Import Maps but extract dependencies
        html = html.replace(/<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi, (match, content) => {
            try {
                const map = JSON.parse(content);
                if (map.imports) {
                    Object.values(map.imports).forEach(url => this.normalizeImport(url));
                }
            } catch (e) { /* ignore parse errors */ }
            return '<!-- Import Map Removed -->';
        });

        // 2. Identify and Process Remote Scripts (CDNs)
        html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, content) => {
            const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
            
            // Case A: Remote Script
            if (srcMatch && srcMatch[1].match(/^(https?:|\/\/)/i)) {
                const src = srcMatch[1];
                
                // Tailwind CSS (Play CDN)
                if (src.includes('cdn.tailwindcss.com')) {
                    this.hasTailwind = true;
                    this.dependencies['tailwindcss'] = '^3.4.0';
                    this.dependencies['postcss'] = '^8.4.0';
                    this.dependencies['autoprefixer'] = '^10.4.0';
                    return '<!-- Tailwind CDN converted to Build Step -->';
                }

                // Babel Standalone
                if (src.includes('babel-standalone') || src.includes('babel.min.js')) {
                    return '<!-- Babel Standalone removed (Vite handles JSX) -->';
                }

                // General CDN Map
                const pkgName = this.normalizeImport(src);
                if (pkgName && pkgName !== src) {
                    const barePkg = pkgName.split('/')[0].replace(/^@/, '').split('/')[0]; // Extract base package
                    
                    if (['react', 'react-dom', 'three', 'pixi.js', 'jquery', 'p5', 'phaser'].includes(barePkg) || 
                        ['react', 'react-dom'].includes(pkgName)) {
                        this.globalShims.add(barePkg === 'react' ? 'react' : (barePkg === 'react-dom' ? 'react-dom' : barePkg));
                    }
                    
                    return `<!-- Remote Script ${src} bundled as ${pkgName} -->`;
                }
                
                return `<!-- BLOCKED REMOTE SCRIPT: ${src} -->`;
            }

            // Case B: Local Script
            if (srcMatch) {
                let newTag = match;
                if (!attrs.includes('type="module"')) {
                    if (attrs.includes('type=')) {
                        newTag = newTag.replace(/type=["'](text\/javascript|application\/javascript)["']/i, 'type="module"');
                    } else {
                        newTag = newTag.replace(/<script/i, '<script type="module"');
                    }
                }
                if (attrs.includes('type="text/babel"')) {
                    newTag = newTag.replace('type="text/babel"', 'type="module"');
                }
                return newTag;
            }

            // Case C: Inline Script
            if (!content.trim()) return match;
            if (attrs.includes('application/json')) return match;

            scriptCounter++;
            const safeName = filename.replace(/[^\w]/g, '_');
            // Use .jsx extension if babel type or typical React code to hint Vite
            const isBabel = attrs.includes('type="text/babel"') || 
                           content.includes('React.') || 
                           content.includes('ReactDOM.') ||
                           /<[A-Z][A-Za-z0-9]*[\s>]/g.test(content) || 
                           /className=/g.test(content);
            const ext = isBabel ? 'jsx' : 'js';
            const newScriptName = `${safeName}_inline_${scriptCounter}.${ext}`;
            
            const processedContent = this.processJS(content, newScriptName);
            extractedScripts.push({ filename: newScriptName, content: processedContent });

            // Force module
            let newAttrs = attrs;
            if (attrs.includes('type="text/babel"')) newAttrs = newAttrs.replace('type="text/babel"', 'type="module"');
            else if (!newAttrs.includes('type="module"')) newAttrs += ' type="module"';

            return `<script src="./${newScriptName}" ${newAttrs}></script>`;
        });

        // 3. Inject Polyfills
        const polyfills = `<script type="module" src="./websim_polyfills.js"></script>`;
        if (html.includes('<head>')) {
            html = html.replace('<head>', '<head>' + polyfills);
        } else {
            html = polyfills + '\n' + html;
        }

        // 4. Remove inline event handlers
        html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');

        // 5. Replace WebSim Avatar URLs in HTML attributes
        html = html.replace(/https:\/\/images\.websim\.(ai|com)\/avatar\/[^"']+/g, 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png');

        return { html, extractedScripts };
    }

    processCSS(cssContent, filename = 'style.css') {
        const css = uint8ToString(cssContent);
        
        const depth = (filename.match(/\//g) || []).length;
        const rootPrefix = depth > 0 ? '../'.repeat(depth) : './';

        // Replace absolute paths in url() with relative ones
        // e.g. url(/images/bg.png) -> url(./images/bg.png) or url(../images/bg.png)
        return css.replace(/url\(\s*(['"]?)(\/[^)'"]+)\1\s*\)/gi, (match, quote, path) => {
            if (path.startsWith('//')) return match; // Skip protocol-relative
            return `url(${quote}${rootPrefix}${path.substring(1)}${quote})`;
        });
    }
}

