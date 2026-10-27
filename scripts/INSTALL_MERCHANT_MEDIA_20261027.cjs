#!/usr/bin/env node
// Safe integrator: keeps ALL other changes in the current commerce_routes.js.
const fs = require('fs'), path = require('path');
const file = path.resolve(__dirname,'../src/commerce_routes.js');
const check = process.argv.includes('--check');
if (!fs.existsSync(file)) throw Error('Không tìm thấy src/commerce_routes.js.');
let src=fs.readFileSync(file,'utf8');
const anchor="  r.get('/store', (req,res)=>res.json({merchant:serialize(req.merchantContext.merchant)}));";
if(!src.includes(anchor))throw Error('Không nhận diện được API merchant store. Dừng, chưa sửa file.');
if(!src.includes("r.put('/products/:id'"))throw Error('Thiếu API product update, không tương thích.');
if(!src.includes('const merchantMediaUpload = multer('))throw Error('Thiếu cấu hình multer upload.');
const actions=[];
if(!src.includes("r.post('/products/:id/media'")) actions.push('Thêm upload ảnh món');
const storeIndex=src.indexOf("r.post('/store/media/:kind'");
if(storeIndex<0)throw Error('Thiếu API store media.');
const currentStore=src.slice(storeIndex,src.indexOf("r.get('/verification'",storeIndex));
if(!currentStore.includes('verifiedReviewMime(fs.readFileSync(req.file.path)'))actions.push('Xác thực định dạng logo/cover');
if(actions.length===0){console.log('Đã cài Media Upload, không cần sửa.');process.exit(0)}
if(check){console.log('CHECK OK:',actions.join('; '));process.exit(0)}
if(!src.includes("r.post('/products/:id/media'"))src=src.replace(anchor, "  // Upload a real product photo; only the owning merchant can replace it.\n  r.post('/products/:id/media', merchantMediaUpload.single('image'), async (req,res)=>{\n    try {\n      const _id=oid(req.params.id);\n      if(!_id){if(req.file?.path)fs.promises.unlink(req.file.path).catch(()=>{});return res.status(400).json({message:'Product ID không hợp lệ.'});}\n      const merchantId=req.merchantContext.merchant._id;\n      const product=await getDb().collection('products').findOne({_id,merchantId});\n      if(!product){if(req.file?.path)fs.promises.unlink(req.file.path).catch(()=>{});return res.status(404).json({message:'Món ăn không thuộc cửa hàng này.'});}\n      if(!req.file)return res.status(400).json({message:'Chưa chọn ảnh món ăn.'});\n      const detected=verifiedReviewMime(fs.readFileSync(req.file.path).subarray(0,32));\n      const declared=String(req.file.mimetype||'').toLowerCase().replace('image/jpg','image/jpeg');\n      if(!detected||detected!==declared){fs.promises.unlink(req.file.path).catch(()=>{});return res.status(415).json({message:'Nội dung file không phải ảnh JPG, PNG hoặc WEBP hợp lệ.'});}\n      const url=merchantMediaPublicPath(merchantId,req.file.filename);\n      await getDb().collection('products').updateOne({_id,merchantId},{$set:{imageUrl:url,updatedAt:new Date()}});\n      deleteOldMerchantMedia(product.imageUrl,merchantId);\n      return res.json({product:serialize(await getDb().collection('products').findOne({_id,merchantId})),url});\n    }catch(e){if(req.file?.path)fs.promises.unlink(req.file.path).catch(()=>{});return res.status(400).json({message:e.message});}\n  });\n" + anchor);
if(!currentStore.includes('verifiedReviewMime(fs.readFileSync(req.file.path)')){
 const start=src.indexOf("r.post('/store/media/:kind'");
 const end=src.indexOf("r.get('/verification'",start);
 let segment=src.slice(start,end);
 const needle="      if(!req.file)return res.status(400).json({message:'Chưa chọn file ảnh.'});";
 if(!segment.includes(needle))throw Error('Không tìm thấy vị trí xác thực logo/cover. Chưa ghi file.');
 segment=segment.replace(needle,needle+'\n'+"      const detected=verifiedReviewMime(fs.readFileSync(req.file.path).subarray(0,32));\n      const declared=String(req.file.mimetype||'').toLowerCase().replace('image/jpg','image/jpeg');\n      if(!detected || declared!==detected){\n        fs.promises.unlink(req.file.path).catch(()=>{});\n        return res.status(415).json({message:'Tệp không phải ảnh JPG, PNG hoặc WEBP hợp lệ.'});\n      }\n");
 src=src.slice(0,start)+segment+src.slice(end);
}
const backup=file+'.bak-merchant-media-20261027';
if(!fs.existsSync(backup))fs.copyFileSync(file,backup);
fs.writeFileSync(file,src);console.log('Đã ghép:',actions.join('; '));console.log('Sao lưu:',backup);
