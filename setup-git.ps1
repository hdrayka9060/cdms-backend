Write-Host "Setting up Git and pushing to GitHub..." -ForegroundColor Cyan

git init
git config user.name "dipak4200"
git config user.email "dipakjha4200@gmail.com"
git checkout -b dev
git add .
git commit -m "feat: initial CDMS backend - NestJS + MongoDB"
git remote add origin https://github.com/dipak4200/cdms-backend.git
git push -u origin dev

Write-Host "Done! Code pushed to https://github.com/dipak4200/cdms-backend (branch: dev)" -ForegroundColor Green
