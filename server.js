const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const tf = require('@tensorflow/tfjs-node');

// 创建Express应用
const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 配置文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 限制文件大小为10MB
});

// 创建模型和输出目录
const modelsDir = path.join(__dirname, 'models');
const outputDir = path.join(__dirname, 'public', 'outputs');
if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
}
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// 存储模板数据 (代替数据库)
const templates = [];

// 路由：获取所有模板
app.get('/api/templates', (req, res) => {
  res.json(templates);
});

// 路由：创建新模板
app.post('/api/templates', upload.array('images', 10), async (req, res) => {
  try {
    const { name } = req.body;
    const images = req.files;
    
    if (!name || !images || images.length < 5) {
      return res.status(400).json({ error: '需要模板名称和至少5张图片' });
    }
    
    // 为模板创建唯一ID
    const templateId = Date.now().toString();
    
    // 创建模板目录
    const templateDir = path.join(modelsDir, templateId);
    fs.mkdirSync(templateDir, { recursive: true });
    
    // 保存模板信息
    const imageUrls = [];
    for (const image of images) {
      imageUrls.push(`/uploads/${image.filename}`);
    }
    
    // 创建缩略图
    const thumbnailPath = await createThumbnail(images[0].path, templateId);
    
    // 训练模型
    const modelPath = await trainStyleModel(images, templateId);
    
    // 保存模板信息
    const template = {
      _id: templateId,
      name,
      imageCount: images.length,
      thumbnailUrl: `/outputs/thumbnail-${templateId}.jpg`,
      modelPath,
      createdAt: new Date()
    };
    
    templates.push(template);
    res.status(201).json(template);
  } catch (error) {
    console.error('创建模板错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 路由：删除模板
app.delete('/api/templates/:id', (req, res) => {
  try {
    const templateId = req.params.id;
    const templateIndex = templates.findIndex(t => t._id === templateId);
    
    if (templateIndex === -1) {
      return res.status(404).json({ error: '模板不存在' });
    }
    
    // 删除模板文件夹
    const templateDir = path.join(modelsDir, templateId);
    if (fs.existsSync(templateDir)) {
      fs.rmdirSync(templateDir, { recursive: true });
    }
    
    // 从数组中删除
    templates.splice(templateIndex, 1);
    
    res.json({ success: true });
  } catch (error) {
    console.error('删除模板错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 路由：转换图片
app.post('/api/convert', upload.single('photo'), async (req, res) => {
  try {
    const { templateId, generateOutline, generateColored } = req.body;
    const photo = req.file;
    
    if (!templateId || !photo) {
      return res.status(400).json({ error: '需要模板ID和照片' });
    }
    
    // 查找模板
    const template = templates.find(t => t._id === templateId);
    if (!template) {
      return res.status(404).json({ error: '模板不存在' });
    }
    
    const results = {};
    
    // 生成线稿
    if (generateOutline === 'true') {
      const outlinePath = await generateOutlineDrawing(photo.path, templateId);
      results.outline = `/outputs/outline-${Date.now()}.jpg`;
    }
    
    // 生成彩色插画
    if (generateColored === 'true') {
      const coloredPath = await generateColoredIllustration(photo.path, templateId, template);
      results.colored = `/outputs/colored-${Date.now()}.jpg`;
    }
    
    res.json(results);
  } catch (error) {
    console.error('转换图片错误:', error);
    res.status(500).json({ error: '转换失败' });
  }
});

// 创建缩略图
async function createThumbnail(imagePath, templateId) {
  try {
    const outputPath = path.join(outputDir, `thumbnail-${templateId}.jpg`);
    
    // 使用Canvas创建缩略图
    const canvas = createCanvas(200, 200);
    const ctx = canvas.getContext('2d');
    
    const image = await loadImage(imagePath);
    
    // 计算缩放和裁剪参数以适应正方形
    const aspectRatio = image.width / image.height;
    let srcWidth, srcHeight, srcX, srcY;
    
    if (aspectRatio > 1) {
      // 如果原图比例宽于高
      srcHeight = image.height;
      srcWidth = image.height;
      srcX = (image.width - srcWidth) / 2;
      srcY = 0;
    } else {
      // 如果原图比例高于宽
      srcWidth = image.width;
      srcHeight = image.width;
      srcX = 0;
      srcY = (image.height - srcHeight) / 2;
    }
    
    // 绘制缩略图
    ctx.drawImage(image, srcX, srcY, srcWidth, srcHeight, 0, 0, 200, 200);
    
    // 保存为文件
    const out = fs.createWriteStream(outputPath);
    const stream = canvas.createJPEGStream({ quality: 0.8 });
    stream.pipe(out);
    
    return new Promise((resolve, reject) => {
      out.on('finish', () => resolve(outputPath));
      out.on('error', reject);
    });
  } catch (error) {
    console.error('创建缩略图错误:', error);
    throw error;
  }
}

// 训练风格迁移模型
async function trainStyleModel(images, templateId) {
  try {
    // 实际开发中这里应该进行真正的模型训练
    // 为了演示，我们只是模拟了训练过程
    
    // 创建模型保存路径
    const modelPath = path.join(modelsDir, templateId, 'model.json');
    
    // 模拟模型训练延迟
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 这里应该有真正的模型训练代码
    // 因为实际训练风格迁移模型需要GPU和大量计算资源
    // 训练完成后保存模型
    
    // 返回模型路径
    return modelPath;
  } catch (error) {
    console.error('训练模型错误:', error);
    throw error;
  }
}

// 生成线稿
async function generateOutlineDrawing(imagePath, templateId) {
  try {
    const outputPath = path.join(outputDir, `outline-${Date.now()}.jpg`);
    
    // 使用Canvas进行图像处理
    const canvas = createCanvas(800, 600);
    const ctx = canvas.getContext('2d');
    
    const image = await loadImage(imagePath);
    
    // 调整canvas大小以匹配图像比例
    const aspectRatio = image.width / image.height;
    let width, height;
    
    if (aspectRatio > 4/3) {
      width = 800;
      height = 800 / aspectRatio;
    } else {
      height = 600;
      width = 600 * aspectRatio;
    }
    
    canvas.width = width;
    canvas.height = height;
    
    // 绘制原始图像
    ctx.drawImage(image, 0, 0, width, height);
    
    // 获取图像数据
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    
    // 简单的边缘检测算法 (Sobel)
    const grayscaleData = new Uint8ClampedArray(data.length / 4);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      grayscaleData[i / 4] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    
    // 创建结果图像
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    
    // 这里应该有更复杂的线稿生成算法
    // 简单模拟，绘制一些随机线条
    for (let x = 0; x < width; x += 5) {
      for (let y = 0; y < height; y += 5) {
        const idx = (y * width + x);
        if (grayscaleData[idx] < 100) {  // 检测暗区域
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 2, y + 2);
          ctx.stroke();
        }
      }
    }
    
    // 保存为文件
    const out = fs.createWriteStream(outputPath);
    const stream = canvas.createJPEGStream({ quality: 0.9 });
    stream.pipe(out);
    
    return new Promise((resolve, reject) => {
      out.on('finish', () => resolve(outputPath));
      out.on('error', reject);
    });
  } catch (error) {
    console.error('生成线稿错误:', error);
    throw error;
  }
}

// 生成彩色插画
async function generateColoredIllustration(imagePath, templateId, template) {
  try {
    const outputPath = path.join(outputDir, `colored-${Date.now()}.jpg`);
    
    // 使用Canvas进行图像处理
    const canvas = createCanvas(800, 600);
    const ctx = canvas.getContext('2d');
    
    const image = await loadImage(imagePath);
    
    // 调整canvas大小以匹配图像比例
    const aspectRatio = image.width / image.height;
    let width, height;
    
    if (aspectRatio > 4/3) {
      width = 800;
      height = 800 / aspectRatio;
    } else {
      height = 600;
      width = 600 * aspectRatio;
    }
    
    canvas.width = width;
    canvas.height = height;
    
    // 绘制原始图像
    ctx.drawImage(image, 0, 0, width, height);
    
    // 获取图像数据
    const imageData = ctx.getImageData(0, 0, width, height);
    
    // 这里应该应用风格迁移模型
    // 由于我们没有真正训练模型，这里进行简单的风格化处理
    
    // 简单风格化：增强饱和度，增加对比度，添加卡通效果
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      // 增强饱和度
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      const avg = (r + g + b) / 3;
      data[i] = r + (r - avg) * 0.5;
      data[i + 1] = g + (g - avg) * 0.5;
      data[i + 2] = b + (b - avg) * 0.5;
      
      // 量化颜色 (卡通效果)
      data[i] = Math.round(data[i] / 32) * 32;
      data[i + 1] = Math.round(data[i + 1] / 32) * 32;
      data[i + 2] = Math.round(data[i + 2] / 32) * 32;
    }
    
    // 更新图像
    ctx.putImageData(imageData, 0, 0);
    
    // 添加轮廓
    const outlineCanvas = createCanvas(width, height);
    const outlineCtx = outlineCanvas.getContext('2d');
    outlineCtx.drawImage(canvas, 0, 0);
    
    // 简化的边缘检测
    const outlineData = outlineCtx.getImageData(0, 0, width, height);
    const outlinePixels = outlineData.data;
    
    // 创建临时数组用于边缘检测
    const edgeData = new Uint8ClampedArray(outlinePixels.length);
    for (let i = 0; i < outlinePixels.length; i++) {
      edgeData[i] = outlinePixels[i];
    }
    
    // 简单边缘检测
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;
        
        // 检查相邻像素
        const left = (y * width + (x - 1)) * 4;
        const right = (y * width + (x + 1)) * 4;
        const up = ((y - 1) * width + x) * 4;
        const down = ((y + 1) * width + x) * 4;
        
        // 计算差异
        const diffX = Math.abs(edgeData[left] - edgeData[right]) + 
                      Math.abs(edgeData[left + 1] - edgeData[right + 1]) + 
                      Math.abs(edgeData[left + 2] - edgeData[right + 2]);
                      
        const diffY = Math.abs(edgeData[up] - edgeData[down]) + 
                      Math.abs(edgeData[up + 1] - edgeData[down + 1]) + 
                      Math.abs(edgeData[up + 2] - edgeData[down + 2]);
        
        // 如果差异大，绘制黑色轮廓
        if (diffX > 100 || diffY > 100) {
          outlinePixels[idx] = 0;
          outlinePixels[idx + 1] = 0;
          outlinePixels[idx + 2] = 0;
        }
      }
    }
    
    outlineCtx.putImageData(outlineData, 0, 0);
    
    // 将轮廓和风格化图像合并
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(outlineCanvas, 0, 0);
    
    // 保存为文件
    const out = fs.createWriteStream(outputPath);
    const stream = canvas.createJPEGStream({ quality: 0.9 });
    stream.pipe(out);
    
    return new Promise((resolve, reject) => {
      out.on('finish', () => resolve(outputPath));
      out.on('error', reject);
    });
  } catch (error) {
    console.error('生成彩色插画错误:', error);
    throw error;
  }
}

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
}); 