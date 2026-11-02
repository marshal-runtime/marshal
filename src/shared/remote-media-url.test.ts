import {afterEach,describe,expect,it} from 'vitest';
import {remoteMediaUrl} from './remote-media-url';
afterEach(()=>{delete window.marshalRemote;});
describe('browser media URLs',()=>{
 it('keeps Electron and public URLs unchanged',()=>{expect(remoteMediaUrl('local-file:///tmp/a.png')).toBe('local-file:///tmp/a.png');window.marshalRemote=true;expect(remoteMediaUrl('https://example.com/a.png')).toBe('https://example.com/a.png');expect(remoteMediaUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');});
 it('encodes a local file reference for the authenticated scoped media endpoint',()=>{window.marshalRemote=true;expect(remoteMediaUrl('file:///tmp/a%20b.png')).toBe(`${location.origin}/remote/media?path=%2Ftmp%2Fa%20b.png`);expect(remoteMediaUrl('/tmp/photo.png')).toBe(`${location.origin}/remote/media?path=%2Ftmp%2Fphoto.png`);});
 it('does not crash rendering malformed user-authored file URLs',()=>{window.marshalRemote=true;expect(remoteMediaUrl('file:///tmp/%ZZ.png')).toBe('file:///tmp/%ZZ.png');});
});
